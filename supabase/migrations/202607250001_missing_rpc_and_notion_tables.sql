-- 补齐 product-payment-webhook 与 notion-oauth-claude 依赖但未追踪的表与 RPC。
-- 所有对象均 security definer + service_role only，RLS 禁止 anon/authenticated 直接访问。

-- =============================================================================
-- 1. product_payment_adjustments 表
--    被 product-payment-webhook handleAdjustment 与 reconcileLifetimeAccess 查询。
-- =============================================================================
create table if not exists public.product_payment_adjustments (
  paddle_adjustment_id text primary key,
  paddle_transaction_id text not null,
  user_id uuid references auth.users(id) on delete set null,
  product_slug text not null,
  action text,
  adjustment_type text,
  status text,
  raw jsonb not null default '{}'::jsonb,
  last_event_id text,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_product_payment_adjustments_updated_at on public.product_payment_adjustments;
create trigger set_product_payment_adjustments_updated_at
before update on public.product_payment_adjustments
for each row
execute function public.set_updated_at();

create index if not exists product_payment_adjustments_user_idx on public.product_payment_adjustments(product_slug, user_id);
create index if not exists product_payment_adjustments_transaction_idx on public.product_payment_adjustments(product_slug, paddle_transaction_id);

alter table public.product_payment_adjustments enable row level security;

revoke all on public.product_payment_adjustments from anon, authenticated;

drop policy if exists "product_payment_adjustments_no_client_access" on public.product_payment_adjustments;
create policy "product_payment_adjustments_no_client_access"
on public.product_payment_adjustments
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

-- 给 product_payment_transactions 补 last_event_id / occurred_at 列（若不存在）
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'product_payment_transactions'
                 and column_name = 'last_event_id') then
    alter table public.product_payment_transactions add column last_event_id text;
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'product_payment_transactions'
                 and column_name = 'occurred_at') then
    alter table public.product_payment_transactions add column occurred_at timestamptz;
  end if;
end $$;

-- 给 product_payment_subscriptions 补 last_event_id / occurred_at 列（若不存在）
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'product_payment_subscriptions'
                 and column_name = 'last_event_id') then
    alter table public.product_payment_subscriptions add column last_event_id text;
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'product_payment_subscriptions'
                 and column_name = 'occurred_at') then
    alter table public.product_payment_subscriptions add column occurred_at timestamptz;
  end if;
end $$;

-- 给 product_profiles 补 lifetime_source / lifetime_transaction_id 列（若不存在）
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'product_profiles'
                 and column_name = 'lifetime_source') then
    alter table public.product_profiles add column lifetime_source text;
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'product_profiles'
                 and column_name = 'lifetime_transaction_id') then
    alter table public.product_profiles add column lifetime_transaction_id text;
  end if;
end $$;

-- =============================================================================
-- 2. paddle_event_is_newer 函数
--    事件乱序保护：判断新事件是否比已记录事件更新。
--    occurred_at 为主要排序键，event_id 字符串比较作为 tiebreaker。
-- =============================================================================
create or replace function public.paddle_event_is_newer(
  p_new_event_id text,
  p_new_occurred_at timestamptz,
  p_existing_event_id text,
  p_existing_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 无现有事件：新事件总是胜出
  if p_existing_event_id is null and p_existing_occurred_at is null then
    return true;
  end if;

  -- occurred_at 严格更新：胜出
  if p_new_occurred_at is not null and p_existing_occurred_at is not null then
    if p_new_occurred_at > p_existing_occurred_at then
      return true;
    end if;
    if p_new_occurred_at < p_existing_occurred_at then
      return false;
    end if;
    -- occurred_at 相同：用 event_id 字符串比较作为 tiebreaker，避免相同时间戳的事件互相覆盖
    if p_new_event_id is not null and p_existing_event_id is not null and p_new_event_id <> p_existing_event_id then
      return p_new_event_id > p_existing_event_id;
    end if;
    -- 完全相同的 event_id：重复事件，不覆盖
    return false;
  end if;

  -- occurred_at 缺失：只要有 event_id 差异即视为更新
  if p_new_event_id is not null and (p_existing_event_id is null or p_new_event_id <> p_existing_event_id) then
    return true;
  end if;

  return false;
end;
$$;

revoke all on function public.paddle_event_is_newer(text, timestamptz, text, timestamptz) from public, anon, authenticated;
grant execute on function public.paddle_event_is_newer(text, timestamptz, text, timestamptz) to service_role;

-- =============================================================================
-- 3. apply_product_payment_transaction_event RPC
--    原子化 upsert transaction，附带事件乱序保护。
-- =============================================================================
create or replace function public.apply_product_payment_transaction_event(
  p_record jsonb,
  p_occurred_at timestamptz,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction_id text;
  v_existing_event_id text;
  v_existing_occurred_at timestamptz;
  v_product_slug text;
  v_user_id uuid;
begin
  v_transaction_id := p_record->>'paddle_transaction_id';
  v_product_slug := p_record->>'product_slug';
  v_user_id := nullif(p_record->>'user_id', '')::uuid;

  if v_transaction_id is null or v_product_slug is null then
    raise exception 'paddle_transaction_id and product_slug are required';
  end if;

  -- 读取现有记录的事件元数据
  select last_event_id, occurred_at into v_existing_event_id, v_existing_occurred_at
  from public.product_payment_transactions
  where paddle_transaction_id = v_transaction_id;

  -- 事件乱序保护：旧事件不覆盖新事件
  if not public.paddle_event_is_newer(p_event_id, p_occurred_at, v_existing_event_id, v_existing_occurred_at) then
    return false;
  end if;

  insert into public.product_payment_transactions (
    paddle_transaction_id,
    user_id,
    product_slug,
    provider_id,
    paddle_customer_id,
    paddle_subscription_id,
    paddle_price_id,
    plan_id,
    billing_interval,
    status,
    total_amount,
    currency_code,
    raw,
    last_event_id,
    occurred_at
  )
  values (
    v_transaction_id,
    v_user_id,
    v_product_slug,
    coalesce(p_record->>'provider_id', 'paddle'),
    nullif(p_record->>'paddle_customer_id', ''),
    nullif(p_record->>'paddle_subscription_id', ''),
    nullif(p_record->>'paddle_price_id', ''),
    nullif(p_record->>'plan_id', ''),
    nullif(p_record->>'billing_interval', ''),
    nullif(p_record->>'status', ''),
    nullif(p_record->>'total_amount', ''),
    nullif(p_record->>'currency_code', ''),
    coalesce(p_record->'raw', '{}'::jsonb),
    p_event_id,
    p_occurred_at
  )
  on conflict (paddle_transaction_id) do update
  set
    user_id = excluded.user_id,
    product_slug = excluded.product_slug,
    provider_id = excluded.provider_id,
    paddle_customer_id = excluded.paddle_customer_id,
    paddle_subscription_id = excluded.paddle_subscription_id,
    paddle_price_id = excluded.paddle_price_id,
    plan_id = excluded.plan_id,
    billing_interval = excluded.billing_interval,
    status = excluded.status,
    total_amount = excluded.total_amount,
    currency_code = excluded.currency_code,
    raw = excluded.raw,
    last_event_id = excluded.last_event_id,
    occurred_at = excluded.occurred_at;

  return true;
end;
$$;

revoke all on function public.apply_product_payment_transaction_event(jsonb, timestamptz, text) from public, anon, authenticated;
grant execute on function public.apply_product_payment_transaction_event(jsonb, timestamptz, text) to service_role;

-- =============================================================================
-- 4. apply_product_payment_subscription_event RPC
-- =============================================================================
create or replace function public.apply_product_payment_subscription_event(
  p_record jsonb,
  p_occurred_at timestamptz,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subscription_id text;
  v_existing_event_id text;
  v_existing_occurred_at timestamptz;
  v_product_slug text;
  v_user_id uuid;
begin
  v_subscription_id := p_record->>'paddle_subscription_id';
  v_product_slug := p_record->>'product_slug';
  v_user_id := nullif(p_record->>'user_id', '')::uuid;

  if v_subscription_id is null or v_product_slug is null then
    raise exception 'paddle_subscription_id and product_slug are required';
  end if;

  select last_event_id, occurred_at into v_existing_event_id, v_existing_occurred_at
  from public.product_payment_subscriptions
  where paddle_subscription_id = v_subscription_id;

  if not public.paddle_event_is_newer(p_event_id, p_occurred_at, v_existing_event_id, v_existing_occurred_at) then
    return false;
  end if;

  insert into public.product_payment_subscriptions (
    paddle_subscription_id,
    user_id,
    product_slug,
    provider_id,
    paddle_customer_id,
    paddle_price_id,
    plan_id,
    billing_interval,
    status,
    current_period_start,
    current_period_end,
    canceled_at,
    raw,
    last_event_id,
    occurred_at
  )
  values (
    v_subscription_id,
    v_user_id,
    v_product_slug,
    coalesce(p_record->>'provider_id', 'paddle'),
    nullif(p_record->>'paddle_customer_id', ''),
    nullif(p_record->>'paddle_price_id', ''),
    nullif(p_record->>'plan_id', ''),
    nullif(p_record->>'billing_interval', ''),
    nullif(p_record->>'status', ''),
    nullif(p_record->>'current_period_start', '')::timestamptz,
    nullif(p_record->>'current_period_end', '')::timestamptz,
    nullif(p_record->>'canceled_at', '')::timestamptz,
    coalesce(p_record->'raw', '{}'::jsonb),
    p_event_id,
    p_occurred_at
  )
  on conflict (paddle_subscription_id) do update
  set
    user_id = excluded.user_id,
    product_slug = excluded.product_slug,
    provider_id = excluded.provider_id,
    paddle_customer_id = excluded.paddle_customer_id,
    paddle_price_id = excluded.paddle_price_id,
    plan_id = excluded.plan_id,
    billing_interval = excluded.billing_interval,
    status = excluded.status,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    canceled_at = excluded.canceled_at,
    raw = excluded.raw,
    last_event_id = excluded.last_event_id,
    occurred_at = excluded.occurred_at;

  return true;
end;
$$;

revoke all on function public.apply_product_payment_subscription_event(jsonb, timestamptz, text) from public, anon, authenticated;
grant execute on function public.apply_product_payment_subscription_event(jsonb, timestamptz, text) to service_role;

-- =============================================================================
-- 5. apply_product_payment_adjustment_event RPC
-- =============================================================================
create or replace function public.apply_product_payment_adjustment_event(
  p_record jsonb,
  p_occurred_at timestamptz,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adjustment_id text;
  v_existing_event_id text;
  v_existing_occurred_at timestamptz;
  v_product_slug text;
  v_user_id uuid;
begin
  v_adjustment_id := p_record->>'paddle_adjustment_id';
  v_product_slug := p_record->>'product_slug';
  v_user_id := nullif(p_record->>'user_id', '')::uuid;

  if v_adjustment_id is null or v_product_slug is null then
    raise exception 'paddle_adjustment_id and product_slug are required';
  end if;

  select last_event_id, occurred_at into v_existing_event_id, v_existing_occurred_at
  from public.product_payment_adjustments
  where paddle_adjustment_id = v_adjustment_id;

  if not public.paddle_event_is_newer(p_event_id, p_occurred_at, v_existing_event_id, v_existing_occurred_at) then
    return false;
  end if;

  insert into public.product_payment_adjustments (
    paddle_adjustment_id,
    paddle_transaction_id,
    user_id,
    product_slug,
    action,
    adjustment_type,
    status,
    raw,
    last_event_id,
    occurred_at
  )
  values (
    v_adjustment_id,
    p_record->>'paddle_transaction_id',
    v_user_id,
    v_product_slug,
    nullif(p_record->>'action', ''),
    nullif(p_record->>'adjustment_type', ''),
    nullif(p_record->>'status', ''),
    coalesce(p_record->'raw', '{}'::jsonb),
    p_event_id,
    p_occurred_at
  )
  on conflict (paddle_adjustment_id) do update
  set
    paddle_transaction_id = excluded.paddle_transaction_id,
    user_id = excluded.user_id,
    product_slug = excluded.product_slug,
    action = excluded.action,
    adjustment_type = excluded.adjustment_type,
    status = excluded.status,
    raw = excluded.raw,
    last_event_id = excluded.last_event_id,
    occurred_at = excluded.occurred_at;

  return true;
end;
$$;

revoke all on function public.apply_product_payment_adjustment_event(jsonb, timestamptz, text) from public, anon, authenticated;
grant execute on function public.apply_product_payment_adjustment_event(jsonb, timestamptz, text) to service_role;

-- =============================================================================
-- 6. notion_connections 表
--    存储按产品隔离的 Notion OAuth 连接。
-- =============================================================================
create table if not exists public.notion_connections (
  id uuid primary key default gen_random_uuid(),
  chatvault_user_id uuid not null references auth.users(id) on delete cascade,
  bot_id text not null,
  workspace_id text,
  workspace_name text,
  workspace_icon text,
  owner_user_id text,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  key_version integer not null default 1,
  status text not null default 'active',
  product_slug text not null,
  last_refreshed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chatvault_user_id, product_slug, bot_id)
);

drop trigger if exists set_notion_connections_updated_at on public.notion_connections;
create trigger set_notion_connections_updated_at
before update on public.notion_connections
for each row
execute function public.set_updated_at();

create index if not exists notion_connections_user_idx on public.notion_connections(product_slug, chatvault_user_id);
create index if not exists notion_connections_workspace_idx on public.notion_connections(workspace_id);

alter table public.notion_connections enable row level security;

revoke all on public.notion_connections from anon, authenticated;

drop policy if exists "notion_connections_no_client_access" on public.notion_connections;
create policy "notion_connections_no_client_access"
on public.notion_connections
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

-- =============================================================================
-- 7. notion_oauth_state 表
--    OAuth state 一次性消费，防止 CSRF 重放。
-- =============================================================================
create table if not exists public.notion_oauth_state (
  state_hash text primary key,
  chatvault_user_id uuid not null references auth.users(id) on delete cascade,
  final_redirect_uri text not null,
  flow_challenge_hash text,
  product_slug text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists notion_oauth_state_user_idx on public.notion_oauth_state(chatvault_user_id);

alter table public.notion_oauth_state enable row level security;

revoke all on public.notion_oauth_state from anon, authenticated;

drop policy if exists "notion_oauth_state_no_client_access" on public.notion_oauth_state;
create policy "notion_oauth_state_no_client_access"
on public.notion_oauth_state
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

-- =============================================================================
-- 8. notion_oauth_result 表
--    一次性 result_code，5 分钟过期，防止重放。
-- =============================================================================
create table if not exists public.notion_oauth_result (
  result_code_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.notion_connections(id) on delete cascade,
  flow_challenge_hash text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists notion_oauth_result_user_idx on public.notion_oauth_result(user_id);

alter table public.notion_oauth_result enable row level security;

revoke all on public.notion_oauth_result from anon, authenticated;

drop policy if exists "notion_oauth_result_no_client_access" on public.notion_oauth_result;
create policy "notion_oauth_result_no_client_access"
on public.notion_oauth_result
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

-- =============================================================================
-- 9. consume_notion_oauth_state RPC
--    一次性消费 state：标记 consumed_at 并返回 state row。
--    已消费的 state 不可再次返回（防重放）。
-- =============================================================================
create or replace function public.consume_notion_oauth_state(
  p_state_hash text
)
returns table(
  chatvault_user_id uuid,
  final_redirect_uri text,
  flow_challenge_hash text,
  product_slug text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.notion_oauth_state%rowtype;
begin
  if nullif(p_state_hash, '') is null then
    return;
  end if;

  -- 原子化消费：仅当未消费且未过期（创建时间在 10 分钟内）时才标记并返回
  update public.notion_oauth_state
  set consumed_at = now()
  where state_hash = p_state_hash
    and consumed_at is null
    and created_at > now() - interval '10 minutes'
  returning * into v_state;

  if v_state is null then
    return;
  end if;

  chatvault_user_id := v_state.chatvault_user_id;
  final_redirect_uri := v_state.final_redirect_uri;
  flow_challenge_hash := v_state.flow_challenge_hash;
  product_slug := v_state.product_slug;
  return next;
  return;
end;
$$;

revoke all on function public.consume_notion_oauth_state(text) from public, anon, authenticated;
grant execute on function public.consume_notion_oauth_state(text) to service_role;

-- =============================================================================
-- 10. issue_notion_oauth_result RPC
--     写入 result_code_hash，限制每个用户未消费 result 数量 ≤ 5 防滥用。
-- =============================================================================
create or replace function public.issue_notion_oauth_result(
  p_result_code_hash text,
  p_user_id uuid,
  p_connection_id uuid,
  p_flow_challenge_hash text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending_count integer;
begin
  if nullif(p_result_code_hash, '') is null or p_user_id is null or p_connection_id is null then
    return false;
  end if;

  -- 限制每个用户未消费 result 数量，防止滥用
  select count(*) into v_pending_count
  from public.notion_oauth_result
  where user_id = p_user_id
    and consumed_at is null
    and expires_at > now();

  if v_pending_count >= 5 then
    return false;
  end if;

  -- 清理该用户已过期的 result
  delete from public.notion_oauth_result
  where user_id = p_user_id
    and (expires_at <= now() or consumed_at is not null);

  insert into public.notion_oauth_result (
    result_code_hash,
    user_id,
    connection_id,
    flow_challenge_hash,
    expires_at
  )
  values (
    p_result_code_hash,
    p_user_id,
    p_connection_id,
    p_flow_challenge_hash,
    p_expires_at
  )
  on conflict (result_code_hash) do nothing;

  return found;
end;
$$;

revoke all on function public.issue_notion_oauth_result(text, uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.issue_notion_oauth_result(text, uuid, uuid, text, timestamptz) to service_role;

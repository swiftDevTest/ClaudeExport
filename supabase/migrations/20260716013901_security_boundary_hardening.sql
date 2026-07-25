begin;

-- Never wait behind production traffic long enough to affect live requests.
-- Any lock contention or unexpectedly expensive statement aborts and rolls back
-- the entire migration before Edge Functions are deployed.
set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- Make entitlement provenance explicit so a revoked Paddle lifetime purchase
-- cannot remain sticky while preserving intentionally granted legacy access.
alter table public.profiles
  add column if not exists lifetime_source text,
  add column if not exists lifetime_transaction_id text;
alter table public.product_profiles
  add column if not exists lifetime_source text,
  add column if not exists lifetime_transaction_id text;

update public.profiles
set lifetime_source = case
  when lifetime_access and lower(coalesce(billing_interval, '')) = 'lifetime' and paddle_transaction_id is not null then 'paddle'
  when lifetime_access then 'legacy'
  else null
end,
lifetime_transaction_id = case
  when lifetime_access and lower(coalesce(billing_interval, '')) = 'lifetime' then paddle_transaction_id
  else null
end
where lifetime_source is null;

update public.product_profiles
set lifetime_source = case
  when lifetime_access and lower(coalesce(billing_interval, '')) = 'lifetime' and paddle_transaction_id is not null then 'paddle'
  when lifetime_access then 'legacy'
  else null
end,
lifetime_transaction_id = case
  when lifetime_access and lower(coalesce(billing_interval, '')) = 'lifetime' then paddle_transaction_id
  else null
end
where lifetime_source is null;

alter table public.profiles drop constraint if exists profiles_lifetime_source_check;
alter table public.profiles add constraint profiles_lifetime_source_check
  check (lifetime_source is null or lifetime_source in ('paddle', 'legacy'));
alter table public.product_profiles drop constraint if exists product_profiles_lifetime_source_check;
alter table public.product_profiles add constraint product_profiles_lifetime_source_check
  check (lifetime_source is null or lifetime_source in ('paddle', 'legacy'));

-- Profile creation is performed by the auth trigger / service-role functions.
-- Authenticated clients must never mass-assign billing columns on INSERT.
revoke insert on public.profiles from anon, authenticated;
drop policy if exists "profiles_insert_own_free_only" on public.profiles;
drop policy if exists "profiles_no_client_insert" on public.profiles;
create policy "profiles_no_client_insert"
on public.profiles
as restrictive
for insert
to anon, authenticated
with check (false);

-- Preserve the existing row filters while allowing Postgres to evaluate the
-- authenticated user once per statement instead of once per row.
alter policy "profiles_select_own" on public.profiles
  using ((select auth.uid()) = id);
alter policy "product_profiles_select_own" on public.product_profiles
  using ((select auth.uid()) = user_id);
alter policy "analytics_events_select_own" on public.analytics_events
  using ((select auth.uid()) = user_id);
alter policy "export_usage_daily_select_own" on public.export_usage_daily
  using ((select auth.uid()) = user_id);
alter policy "product_export_usage_daily_select_own" on public.product_export_usage_daily
  using ((select auth.uid()) = user_id);

-- Trigger functions must not be callable as public RPC endpoints. These
-- changes do not affect trigger execution or the service-role write path.
alter function public.handle_ai_chat_export_user() set search_path = '';
revoke all on function public.handle_ai_chat_export_user() from public, anon, authenticated;
alter function public.set_updated_at() set search_path = '';

-- Store Paddle ordering metadata and isolate the shared product subscription key.
alter table public.payment_subscriptions
  add column if not exists last_event_occurred_at timestamptz,
  add column if not exists last_event_id text;
alter table public.payment_transactions
  add column if not exists last_event_occurred_at timestamptz,
  add column if not exists last_event_id text;
alter table public.product_payment_subscriptions
  add column if not exists last_event_occurred_at timestamptz,
  add column if not exists last_event_id text;
alter table public.product_payment_transactions
  add column if not exists last_event_occurred_at timestamptz,
  add column if not exists last_event_id text;

create table if not exists public.payment_adjustments (
  paddle_adjustment_id text primary key,
  paddle_transaction_id text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  product_slug text not null default 'ai-chat-export',
  action text not null,
  adjustment_type text,
  status text not null,
  raw jsonb not null default '{}'::jsonb,
  last_event_occurred_at timestamptz,
  last_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.product_payment_adjustments (
  paddle_adjustment_id text not null,
  paddle_transaction_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_slug text not null,
  action text not null,
  adjustment_type text,
  status text not null,
  raw jsonb not null default '{}'::jsonb,
  last_event_occurred_at timestamptz,
  last_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_slug, paddle_adjustment_id)
);
drop trigger if exists set_payment_adjustments_updated_at on public.payment_adjustments;
create trigger set_payment_adjustments_updated_at
before update on public.payment_adjustments
for each row execute function public.set_updated_at();
drop trigger if exists set_product_payment_adjustments_updated_at on public.product_payment_adjustments;
create trigger set_product_payment_adjustments_updated_at
before update on public.product_payment_adjustments
for each row execute function public.set_updated_at();
create index if not exists payment_adjustments_user_idx
  on public.payment_adjustments(product_slug, user_id);
create index if not exists payment_adjustments_transaction_idx
  on public.payment_adjustments(product_slug, paddle_transaction_id);
create index if not exists product_payment_adjustments_user_idx
  on public.product_payment_adjustments(product_slug, user_id);
create index if not exists product_payment_adjustments_transaction_idx
  on public.product_payment_adjustments(product_slug, paddle_transaction_id);
alter table public.payment_adjustments enable row level security;
alter table public.product_payment_adjustments enable row level security;
revoke all on public.payment_adjustments from public, anon, authenticated;
revoke all on public.product_payment_adjustments from public, anon, authenticated;
grant all on public.payment_adjustments to service_role;
grant all on public.product_payment_adjustments to service_role;

alter table public.product_payment_subscriptions
  drop constraint if exists product_payment_subscriptions_pkey;
alter table public.product_payment_subscriptions
  add primary key (product_slug, paddle_subscription_id);

create or replace function public.paddle_event_is_newer(
  p_existing_occurred_at timestamptz,
  p_existing_event_id text,
  p_incoming_occurred_at timestamptz,
  p_incoming_event_id text
)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_existing_occurred_at is null and p_incoming_occurred_at is not null then true
    when p_existing_occurred_at is not null and p_incoming_occurred_at is null then false
    when p_incoming_occurred_at > p_existing_occurred_at then true
    when p_incoming_occurred_at < p_existing_occurred_at then false
    when (p_existing_occurred_at is null and p_incoming_occurred_at is null)
      or p_incoming_occurred_at = p_existing_occurred_at
      then coalesce(p_incoming_event_id, '') > coalesce(p_existing_event_id, '')
    else false
  end
$$;

create or replace function public.apply_payment_transaction_event(
  p_record jsonb,
  p_occurred_at timestamptz,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  affected_rows integer := 0;
begin
  insert into public.payment_transactions (
    paddle_transaction_id, user_id, product_slug, provider_id, paddle_customer_id,
    paddle_subscription_id, paddle_price_id, plan_id, billing_interval, status,
    total_amount, currency_code, raw, last_event_occurred_at, last_event_id
  ) values (
    p_record->>'paddle_transaction_id', nullif(p_record->>'user_id', '')::uuid,
    coalesce(nullif(p_record->>'product_slug', ''), 'ai-chat-export'),
    coalesce(nullif(p_record->>'provider_id', ''), 'paddle'), p_record->>'paddle_customer_id',
    p_record->>'paddle_subscription_id', p_record->>'paddle_price_id', p_record->>'plan_id',
    p_record->>'billing_interval', p_record->>'status', p_record->>'total_amount',
    p_record->>'currency_code', coalesce(p_record->'raw', '{}'::jsonb), p_occurred_at, p_event_id
  )
  on conflict (paddle_transaction_id) do update set
    user_id = coalesce(excluded.user_id, public.payment_transactions.user_id),
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
    last_event_occurred_at = excluded.last_event_occurred_at,
    last_event_id = excluded.last_event_id
  where public.paddle_event_is_newer(
    public.payment_transactions.last_event_occurred_at,
    public.payment_transactions.last_event_id,
    excluded.last_event_occurred_at,
    excluded.last_event_id
  );
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create or replace function public.apply_payment_subscription_event(
  p_record jsonb,
  p_occurred_at timestamptz,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  affected_rows integer := 0;
begin
  insert into public.payment_subscriptions (
    paddle_subscription_id, user_id, product_slug, provider_id, paddle_customer_id,
    paddle_price_id, plan_id, billing_interval, status, current_period_start,
    current_period_end, canceled_at, raw, last_event_occurred_at, last_event_id
  ) values (
    p_record->>'paddle_subscription_id', nullif(p_record->>'user_id', '')::uuid,
    coalesce(nullif(p_record->>'product_slug', ''), 'ai-chat-export'),
    coalesce(nullif(p_record->>'provider_id', ''), 'paddle'), p_record->>'paddle_customer_id',
    p_record->>'paddle_price_id', p_record->>'plan_id', p_record->>'billing_interval',
    p_record->>'status', nullif(p_record->>'current_period_start', '')::timestamptz,
    nullif(p_record->>'current_period_end', '')::timestamptz,
    nullif(p_record->>'canceled_at', '')::timestamptz,
    coalesce(p_record->'raw', '{}'::jsonb), p_occurred_at, p_event_id
  )
  on conflict (paddle_subscription_id) do update set
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
    last_event_occurred_at = excluded.last_event_occurred_at,
    last_event_id = excluded.last_event_id
  where public.paddle_event_is_newer(
    public.payment_subscriptions.last_event_occurred_at,
    public.payment_subscriptions.last_event_id,
    excluded.last_event_occurred_at,
    excluded.last_event_id
  );
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create or replace function public.apply_product_payment_transaction_event(
  p_record jsonb,
  p_occurred_at timestamptz,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  affected_rows integer := 0;
begin
  insert into public.product_payment_transactions (
    paddle_transaction_id, user_id, product_slug, provider_id, paddle_customer_id,
    paddle_subscription_id, paddle_price_id, plan_id, billing_interval, status,
    total_amount, currency_code, raw, last_event_occurred_at, last_event_id
  ) values (
    p_record->>'paddle_transaction_id', nullif(p_record->>'user_id', '')::uuid,
    p_record->>'product_slug', coalesce(nullif(p_record->>'provider_id', ''), 'paddle'),
    p_record->>'paddle_customer_id', p_record->>'paddle_subscription_id',
    p_record->>'paddle_price_id', p_record->>'plan_id', p_record->>'billing_interval',
    p_record->>'status', p_record->>'total_amount', p_record->>'currency_code',
    coalesce(p_record->'raw', '{}'::jsonb), p_occurred_at, p_event_id
  )
  on conflict (paddle_transaction_id) do update set
    user_id = coalesce(excluded.user_id, public.product_payment_transactions.user_id),
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
    last_event_occurred_at = excluded.last_event_occurred_at,
    last_event_id = excluded.last_event_id
  where public.paddle_event_is_newer(
    public.product_payment_transactions.last_event_occurred_at,
    public.product_payment_transactions.last_event_id,
    excluded.last_event_occurred_at,
    excluded.last_event_id
  );
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create or replace function public.apply_product_payment_subscription_event(
  p_record jsonb,
  p_occurred_at timestamptz,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  affected_rows integer := 0;
begin
  if exists (
    select 1
    from public.product_payment_subscriptions
    where paddle_subscription_id = p_record->>'paddle_subscription_id'
      and product_slug <> p_record->>'product_slug'
      and not public.paddle_event_is_newer(
        last_event_occurred_at,
        last_event_id,
        p_occurred_at,
        p_event_id
      )
  ) then
    return false;
  end if;
  insert into public.product_payment_subscriptions (
    paddle_subscription_id, user_id, product_slug, provider_id, paddle_customer_id,
    paddle_price_id, plan_id, billing_interval, status, current_period_start,
    current_period_end, canceled_at, raw, last_event_occurred_at, last_event_id
  ) values (
    p_record->>'paddle_subscription_id', nullif(p_record->>'user_id', '')::uuid,
    p_record->>'product_slug', coalesce(nullif(p_record->>'provider_id', ''), 'paddle'),
    p_record->>'paddle_customer_id', p_record->>'paddle_price_id', p_record->>'plan_id',
    p_record->>'billing_interval', p_record->>'status',
    nullif(p_record->>'current_period_start', '')::timestamptz,
    nullif(p_record->>'current_period_end', '')::timestamptz,
    nullif(p_record->>'canceled_at', '')::timestamptz,
    coalesce(p_record->'raw', '{}'::jsonb), p_occurred_at, p_event_id
  )
  on conflict (product_slug, paddle_subscription_id) do update set
    user_id = excluded.user_id,
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
    last_event_occurred_at = excluded.last_event_occurred_at,
    last_event_id = excluded.last_event_id
  where public.paddle_event_is_newer(
    public.product_payment_subscriptions.last_event_occurred_at,
    public.product_payment_subscriptions.last_event_id,
    excluded.last_event_occurred_at,
    excluded.last_event_id
  );
  get diagnostics affected_rows = row_count;
  if affected_rows = 1 then
    update public.product_payment_subscriptions
    set status = 'migrated',
        canceled_at = coalesce(canceled_at, p_occurred_at, now()),
        last_event_occurred_at = p_occurred_at,
        last_event_id = p_event_id
    where paddle_subscription_id = p_record->>'paddle_subscription_id'
      and product_slug <> p_record->>'product_slug'
      and public.paddle_event_is_newer(
        last_event_occurred_at,
        last_event_id,
        p_occurred_at,
        p_event_id
      );
  end if;
  return affected_rows = 1;
end;
$$;

create or replace function public.apply_payment_adjustment_event(
  p_record jsonb,
  p_occurred_at timestamptz,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  affected_rows integer := 0;
begin
  insert into public.payment_adjustments (
    paddle_adjustment_id, paddle_transaction_id, user_id, product_slug,
    action, adjustment_type, status, raw, last_event_occurred_at, last_event_id
  ) values (
    p_record->>'paddle_adjustment_id', p_record->>'paddle_transaction_id',
    nullif(p_record->>'user_id', '')::uuid,
    coalesce(nullif(p_record->>'product_slug', ''), 'ai-chat-export'),
    p_record->>'action', p_record->>'adjustment_type', p_record->>'status',
    coalesce(p_record->'raw', '{}'::jsonb), p_occurred_at, p_event_id
  )
  on conflict (paddle_adjustment_id) do update set
    paddle_transaction_id = excluded.paddle_transaction_id,
    user_id = excluded.user_id,
    product_slug = excluded.product_slug,
    action = excluded.action,
    adjustment_type = excluded.adjustment_type,
    status = excluded.status,
    raw = excluded.raw,
    last_event_occurred_at = excluded.last_event_occurred_at,
    last_event_id = excluded.last_event_id
  where public.paddle_event_is_newer(
    public.payment_adjustments.last_event_occurred_at,
    public.payment_adjustments.last_event_id,
    excluded.last_event_occurred_at,
    excluded.last_event_id
  );
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create or replace function public.apply_product_payment_adjustment_event(
  p_record jsonb,
  p_occurred_at timestamptz,
  p_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  affected_rows integer := 0;
begin
  insert into public.product_payment_adjustments (
    paddle_adjustment_id, paddle_transaction_id, user_id, product_slug,
    action, adjustment_type, status, raw, last_event_occurred_at, last_event_id
  ) values (
    p_record->>'paddle_adjustment_id', p_record->>'paddle_transaction_id',
    nullif(p_record->>'user_id', '')::uuid, p_record->>'product_slug',
    p_record->>'action', p_record->>'adjustment_type', p_record->>'status',
    coalesce(p_record->'raw', '{}'::jsonb), p_occurred_at, p_event_id
  )
  on conflict (product_slug, paddle_adjustment_id) do update set
    paddle_transaction_id = excluded.paddle_transaction_id,
    user_id = excluded.user_id,
    action = excluded.action,
    adjustment_type = excluded.adjustment_type,
    status = excluded.status,
    raw = excluded.raw,
    last_event_occurred_at = excluded.last_event_occurred_at,
    last_event_id = excluded.last_event_id
  where public.paddle_event_is_newer(
    public.product_payment_adjustments.last_event_occurred_at,
    public.product_payment_adjustments.last_event_id,
    excluded.last_event_occurred_at,
    excluded.last_event_id
  );
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

revoke all on function public.paddle_event_is_newer(timestamptz, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.apply_payment_transaction_event(jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.apply_payment_subscription_event(jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.apply_product_payment_transaction_event(jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.apply_product_payment_subscription_event(jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.apply_payment_adjustment_event(jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.apply_product_payment_adjustment_event(jsonb, timestamptz, text) from public, anon, authenticated;
grant execute on function public.paddle_event_is_newer(timestamptz, text, timestamptz, text) to service_role;
grant execute on function public.apply_payment_transaction_event(jsonb, timestamptz, text) to service_role;
grant execute on function public.apply_payment_subscription_event(jsonb, timestamptz, text) to service_role;
grant execute on function public.apply_product_payment_transaction_event(jsonb, timestamptz, text) to service_role;
grant execute on function public.apply_product_payment_subscription_event(jsonb, timestamptz, text) to service_role;
grant execute on function public.apply_payment_adjustment_event(jsonb, timestamptz, text) to service_role;
grant execute on function public.apply_product_payment_adjustment_event(jsonb, timestamptz, text) to service_role;

-- Bind OAuth completion to the extension instance that initiated the flow.
delete from public.notion_oauth_results;
delete from public.notion_oauth_states;
alter table public.notion_oauth_states add column if not exists flow_challenge_hash text;
alter table public.notion_oauth_results add column if not exists flow_challenge_hash text;
alter table public.notion_oauth_states alter column flow_challenge_hash set not null;
alter table public.notion_oauth_results alter column flow_challenge_hash set not null;
create index if not exists notion_oauth_states_expires_idx on public.notion_oauth_states(expires_at);
create index if not exists notion_oauth_results_expires_idx on public.notion_oauth_results(expires_at);

alter table public.notion_connections drop constraint if exists notion_connections_status_check;
alter table public.notion_connections add constraint notion_connections_status_check
  check (status in ('pending_oauth', 'active', 'reconnect_required', 'revoked'));

create or replace function public.issue_notion_oauth_state(
  p_state_hash text,
  p_user_id uuid,
  p_final_redirect_uri text,
  p_flow_challenge_hash text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  pending_count integer;
begin
  if p_state_hash !~ '^[a-f0-9]{64}$' or p_flow_challenge_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  delete from public.notion_oauth_states
  where ctid in (
    select ctid from public.notion_oauth_states
    where expires_at <= now()
    order by expires_at asc limit 100
  );
  select count(*) into pending_count
  from public.notion_oauth_states
  where chatvault_user_id = p_user_id and expires_at > now();
  if pending_count >= 5 then return false; end if;
  insert into public.notion_oauth_states (
    state_hash, chatvault_user_id, final_redirect_uri, flow_challenge_hash, expires_at
  ) values (
    p_state_hash, p_user_id, p_final_redirect_uri, p_flow_challenge_hash, p_expires_at
  );
  return true;
end;
$$;

drop function if exists public.consume_notion_oauth_state(text);
create or replace function public.consume_notion_oauth_state(p_state_hash text)
returns table(chatvault_user_id uuid, final_redirect_uri text, flow_challenge_hash text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return query
  delete from public.notion_oauth_states
  where state_hash = p_state_hash and expires_at > now()
  returning notion_oauth_states.chatvault_user_id,
    notion_oauth_states.final_redirect_uri,
    notion_oauth_states.flow_challenge_hash;
end;
$$;

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
set search_path = pg_catalog, pg_temp
as $$
declare
  pending_count integer;
begin
  if p_result_code_hash !~ '^[a-f0-9]{64}$' or p_flow_challenge_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() or p_expires_at > now() + interval '5 minutes' then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  delete from public.notion_oauth_results
  where ctid in (
    select ctid from public.notion_oauth_results
    where expires_at <= now()
    order by expires_at asc limit 100
  );
  delete from public.notion_oauth_results
  where chatvault_user_id = p_user_id and connection_id = p_connection_id;
  select count(*) into pending_count
  from public.notion_oauth_results
  where chatvault_user_id = p_user_id and expires_at > now();
  if pending_count >= 5 then return false; end if;
  if not exists (
    select 1 from public.notion_connections
    where id = p_connection_id and chatvault_user_id = p_user_id and status = 'pending_oauth'
  ) then return false; end if;
  insert into public.notion_oauth_results (
    result_code_hash, chatvault_user_id, connection_id, flow_challenge_hash, expires_at
  ) values (
    p_result_code_hash, p_user_id, p_connection_id, p_flow_challenge_hash, p_expires_at
  );
  return true;
end;
$$;

drop function if exists public.consume_notion_oauth_result(text, uuid);
create or replace function public.complete_notion_oauth_result(
  p_result_code_hash text,
  p_user_id uuid,
  p_flow_challenge_hash text
)
returns table(connection_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  target_connection_id uuid;
begin
  select notion_oauth_results.connection_id into target_connection_id
  from public.notion_oauth_results
  where result_code_hash = p_result_code_hash
    and chatvault_user_id = p_user_id
    and flow_challenge_hash = p_flow_challenge_hash
    and expires_at > now()
  for update;
  if target_connection_id is null then return; end if;

  update public.notion_connections
  set status = 'active', updated_at = now(), revoked_at = null
  where id = target_connection_id
    and chatvault_user_id = p_user_id
    and status = 'pending_oauth';
  if not found then return; end if;

  delete from public.notion_oauth_results where result_code_hash = p_result_code_hash;
  return query select target_connection_id;
end;
$$;

revoke all on function public.issue_notion_oauth_state(text, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_notion_oauth_state(text) from public, anon, authenticated;
revoke all on function public.issue_notion_oauth_result(text, uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_notion_oauth_result(text, uuid, text) from public, anon, authenticated;
grant execute on function public.issue_notion_oauth_state(text, uuid, text, text, timestamptz) to service_role;
grant execute on function public.consume_notion_oauth_state(text) to service_role;
grant execute on function public.issue_notion_oauth_result(text, uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.complete_notion_oauth_result(text, uuid, text) to service_role;

-- Bound time-bucket rate-limit storage while retaining the atomic counters.
create index if not exists edge_rate_limits_updated_at_idx on public.edge_rate_limits(updated_at);
create index if not exists product_edge_rate_limits_updated_at_idx on public.product_edge_rate_limits(updated_at);

create or replace function public.try_consume_edge_rate_limit(
  p_bucket_key text,
  p_product_slug text,
  p_increment integer,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  consumed boolean := false;
  normalized_increment integer := greatest(1, least(coalesce(p_increment, 1), 25));
  normalized_limit integer := greatest(1, coalesce(p_limit, 120));
begin
  if nullif(p_bucket_key, '') is null then return false; end if;
  delete from public.edge_rate_limits
  where ctid in (
    select ctid from public.edge_rate_limits
    where updated_at < now() - interval '2 days'
    order by updated_at asc limit 100
  );
  insert into public.edge_rate_limits (bucket_key, product_slug, request_count)
  values (p_bucket_key, coalesce(nullif(p_product_slug, ''), 'ai-chat-export'), normalized_increment)
  on conflict (bucket_key) do update
  set request_count = public.edge_rate_limits.request_count + excluded.request_count
  where public.edge_rate_limits.request_count + excluded.request_count <= normalized_limit;
  consumed := found;
  return consumed;
end;
$$;

create or replace function public.try_consume_product_edge_rate_limit(
  p_bucket_key text,
  p_product_slug text,
  p_increment integer,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  consumed boolean := false;
  normalized_increment integer := greatest(1, least(coalesce(p_increment, 1), 25));
  normalized_limit integer := greatest(1, coalesce(p_limit, 120));
  normalized_product_slug text := nullif(p_product_slug, '');
begin
  if nullif(p_bucket_key, '') is null or normalized_product_slug is null then return false; end if;
  delete from public.product_edge_rate_limits
  where ctid in (
    select ctid from public.product_edge_rate_limits
    where updated_at < now() - interval '2 days'
    order by updated_at asc limit 100
  );
  insert into public.product_edge_rate_limits (bucket_key, product_slug, request_count)
  values (p_bucket_key, normalized_product_slug, normalized_increment)
  on conflict (bucket_key) do update
  set request_count = public.product_edge_rate_limits.request_count + excluded.request_count
  where public.product_edge_rate_limits.request_count + excluded.request_count <= normalized_limit;
  consumed := found;
  return consumed;
end;
$$;

revoke all on function public.try_consume_edge_rate_limit(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.try_consume_product_edge_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.try_consume_edge_rate_limit(text, text, integer, integer) to service_role;
grant execute on function public.try_consume_product_edge_rate_limit(text, text, integer, integer) to service_role;

commit;

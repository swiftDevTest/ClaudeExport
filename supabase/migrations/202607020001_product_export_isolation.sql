create extension if not exists pgcrypto;

create table if not exists public.product_profiles (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_slug text not null,
  email text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  provider_id text not null default 'paddle',
  paddle_customer_id text,
  paddle_subscription_id text,
  paddle_transaction_id text,
  paddle_price_id text,
  billing_interval text,
  current_period_end timestamptz,
  lifetime_access boolean not null default false,
  feature_flags jsonb not null default '{}'::jsonb,
  limits jsonb not null default '{"daily_exports":3}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, product_slug)
);

drop trigger if exists set_product_profiles_updated_at on public.product_profiles;
create trigger set_product_profiles_updated_at
before update on public.product_profiles
for each row
execute function public.set_updated_at();

create table if not exists public.product_payment_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_slug text not null,
  provider_id text not null default 'paddle',
  paddle_customer_id text not null,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_slug, paddle_customer_id)
);

drop trigger if exists set_product_payment_customers_updated_at on public.product_payment_customers;
create trigger set_product_payment_customers_updated_at
before update on public.product_payment_customers
for each row
execute function public.set_updated_at();

create table if not exists public.product_payment_subscriptions (
  paddle_subscription_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_slug text not null,
  provider_id text not null default 'paddle',
  paddle_customer_id text,
  paddle_price_id text,
  plan_id text,
  billing_interval text,
  status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_product_payment_subscriptions_updated_at on public.product_payment_subscriptions;
create trigger set_product_payment_subscriptions_updated_at
before update on public.product_payment_subscriptions
for each row
execute function public.set_updated_at();

create table if not exists public.product_payment_transactions (
  paddle_transaction_id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  product_slug text not null,
  provider_id text not null default 'paddle',
  paddle_customer_id text,
  paddle_subscription_id text,
  paddle_price_id text,
  plan_id text,
  billing_interval text,
  status text,
  total_amount text,
  currency_code text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_product_payment_transactions_updated_at on public.product_payment_transactions;
create trigger set_product_payment_transactions_updated_at
before update on public.product_payment_transactions
for each row
execute function public.set_updated_at();

create table if not exists public.product_payment_webhook_events (
  event_id text primary key,
  event_type text not null,
  product_slug text,
  provider_id text not null default 'paddle',
  paddle_customer_id text,
  paddle_subscription_id text,
  paddle_transaction_id text,
  paddle_price_id text,
  user_id uuid references auth.users(id) on delete set null,
  processed boolean not null default false,
  ignored boolean not null default false,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.product_export_usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_slug text not null,
  usage_date date not null default current_date,
  exported_chats integer not null default 0 check (exported_chats >= 0),
  export_events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, product_slug, usage_date)
);

drop trigger if exists set_product_export_usage_daily_updated_at on public.product_export_usage_daily;
create trigger set_product_export_usage_daily_updated_at
before update on public.product_export_usage_daily
for each row
execute function public.set_updated_at();

create table if not exists public.product_analytics_identities (
  guest_id text not null,
  product_slug text not null,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_slug, guest_id)
);

drop trigger if exists set_product_analytics_identities_updated_at on public.product_analytics_identities;
create trigger set_product_analytics_identities_updated_at
before update on public.product_analytics_identities
for each row
execute function public.set_updated_at();

create table if not exists public.product_analytics_events (
  id bigserial primary key,
  guest_id text,
  user_id uuid references auth.users(id) on delete set null,
  product_slug text not null,
  event_name text not null,
  platform text not null default 'unknown',
  properties jsonb not null default '{}'::jsonb,
  client_timestamp timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.product_edge_rate_limits (
  bucket_key text primary key,
  product_slug text not null,
  request_count integer not null default 0 check (request_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_product_edge_rate_limits_updated_at on public.product_edge_rate_limits;
create trigger set_product_edge_rate_limits_updated_at
before update on public.product_edge_rate_limits
for each row
execute function public.set_updated_at();

create index if not exists product_profiles_product_slug_idx on public.product_profiles(product_slug);
create index if not exists product_profiles_paddle_customer_idx on public.product_profiles(product_slug, paddle_customer_id);
create index if not exists product_payment_customers_user_idx on public.product_payment_customers(product_slug, user_id);
create index if not exists product_payment_subscriptions_user_idx on public.product_payment_subscriptions(product_slug, user_id);
create index if not exists product_payment_subscriptions_customer_idx on public.product_payment_subscriptions(product_slug, paddle_customer_id);
create index if not exists product_payment_transactions_user_idx on public.product_payment_transactions(product_slug, user_id);
create index if not exists product_payment_transactions_customer_idx on public.product_payment_transactions(product_slug, paddle_customer_id);
create index if not exists product_payment_webhook_events_user_idx on public.product_payment_webhook_events(user_id);
create index if not exists product_export_usage_daily_date_idx on public.product_export_usage_daily(product_slug, usage_date);
create index if not exists product_analytics_events_guest_idx on public.product_analytics_events(product_slug, guest_id);
create index if not exists product_analytics_events_user_idx on public.product_analytics_events(product_slug, user_id);
create index if not exists product_analytics_events_name_idx on public.product_analytics_events(product_slug, event_name);

alter table public.product_profiles enable row level security;
alter table public.product_payment_customers enable row level security;
alter table public.product_payment_subscriptions enable row level security;
alter table public.product_payment_transactions enable row level security;
alter table public.product_payment_webhook_events enable row level security;
alter table public.product_export_usage_daily enable row level security;
alter table public.product_analytics_identities enable row level security;
alter table public.product_analytics_events enable row level security;
alter table public.product_edge_rate_limits enable row level security;

revoke all on public.product_profiles from anon, authenticated;
revoke all on public.product_payment_customers from anon, authenticated;
revoke all on public.product_payment_subscriptions from anon, authenticated;
revoke all on public.product_payment_transactions from anon, authenticated;
revoke all on public.product_payment_webhook_events from anon, authenticated;
revoke all on public.product_export_usage_daily from anon, authenticated;
revoke all on public.product_analytics_identities from anon, authenticated;
revoke all on public.product_analytics_events from anon, authenticated;
revoke all on public.product_edge_rate_limits from anon, authenticated;

grant select on public.product_profiles to authenticated;
grant select on public.product_export_usage_daily to authenticated;

drop policy if exists "product_profiles_select_own" on public.product_profiles;
create policy "product_profiles_select_own"
on public.product_profiles
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "product_profiles_no_client_write" on public.product_profiles;
create policy "product_profiles_no_client_write"
on public.product_profiles
as restrictive
for insert
to anon, authenticated
with check (false);

drop policy if exists "product_profiles_no_client_update" on public.product_profiles;
create policy "product_profiles_no_client_update"
on public.product_profiles
as restrictive
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "product_profiles_no_client_delete" on public.product_profiles;
create policy "product_profiles_no_client_delete"
on public.product_profiles
as restrictive
for delete
to anon, authenticated
using (false);

drop policy if exists "product_export_usage_daily_select_own" on public.product_export_usage_daily;
create policy "product_export_usage_daily_select_own"
on public.product_export_usage_daily
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "product_export_usage_daily_no_client_write" on public.product_export_usage_daily;
create policy "product_export_usage_daily_no_client_write"
on public.product_export_usage_daily
as restrictive
for insert
to anon, authenticated
with check (false);

drop policy if exists "product_export_usage_daily_no_client_update" on public.product_export_usage_daily;
create policy "product_export_usage_daily_no_client_update"
on public.product_export_usage_daily
as restrictive
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "product_export_usage_daily_no_client_delete" on public.product_export_usage_daily;
create policy "product_export_usage_daily_no_client_delete"
on public.product_export_usage_daily
as restrictive
for delete
to anon, authenticated
using (false);

drop policy if exists "product_payment_customers_no_client_access" on public.product_payment_customers;
create policy "product_payment_customers_no_client_access"
on public.product_payment_customers
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "product_payment_subscriptions_no_client_access" on public.product_payment_subscriptions;
create policy "product_payment_subscriptions_no_client_access"
on public.product_payment_subscriptions
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "product_payment_transactions_no_client_access" on public.product_payment_transactions;
create policy "product_payment_transactions_no_client_access"
on public.product_payment_transactions
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "product_payment_webhook_events_no_client_access" on public.product_payment_webhook_events;
create policy "product_payment_webhook_events_no_client_access"
on public.product_payment_webhook_events
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "product_analytics_identities_no_client_access" on public.product_analytics_identities;
create policy "product_analytics_identities_no_client_access"
on public.product_analytics_identities
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "product_analytics_events_no_client_access" on public.product_analytics_events;
create policy "product_analytics_events_no_client_access"
on public.product_analytics_events
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "product_edge_rate_limits_no_client_access" on public.product_edge_rate_limits;
create policy "product_edge_rate_limits_no_client_access"
on public.product_edge_rate_limits
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

create or replace function public.consume_product_export_usage_daily(
  p_user_id uuid,
  p_product_slug text,
  p_usage_date date,
  p_requested_count integer,
  p_daily_limit integer,
  p_max_events integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  usage_record public.product_export_usage_daily%rowtype;
  consumed boolean := false;
  normalized_count integer := greatest(1, least(coalesce(p_requested_count, 1), 10));
  normalized_limit integer := greatest(0, coalesce(p_daily_limit, 0));
  normalized_product_slug text := nullif(p_product_slug, '');
  event_payload jsonb := jsonb_build_array(jsonb_build_object('at', now(), 'count', greatest(1, least(coalesce(p_requested_count, 1), 10))));
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  if normalized_product_slug is null then
    raise exception 'p_product_slug is required';
  end if;

  if normalized_count <= normalized_limit then
    insert into public.product_export_usage_daily (
      user_id,
      product_slug,
      usage_date,
      exported_chats,
      export_events
    )
    values (
      p_user_id,
      normalized_product_slug,
      p_usage_date,
      normalized_count,
      event_payload
    )
    on conflict (user_id, product_slug, usage_date) do update
    set exported_chats = public.product_export_usage_daily.exported_chats + excluded.exported_chats,
        export_events = (
          select coalesce(jsonb_agg(trimmed.value order by trimmed.ord), '[]'::jsonb)
          from (
            select events.value, events.ord
            from jsonb_array_elements(public.product_export_usage_daily.export_events || excluded.export_events)
              with ordinality as events(value, ord)
            order by events.ord desc
            limit greatest(1, coalesce(p_max_events, 50))
          ) as trimmed
        )
    where public.product_export_usage_daily.exported_chats + excluded.exported_chats <= normalized_limit
    returning * into usage_record;

    consumed := found;
  end if;

  if not consumed then
    select *
    into usage_record
    from public.product_export_usage_daily
    where user_id = p_user_id
      and product_slug = normalized_product_slug
      and usage_date = p_usage_date;
  end if;

  return jsonb_build_object(
    'consumed', consumed,
    'usage_date', coalesce(usage_record.usage_date, p_usage_date),
    'exported_chats', coalesce(usage_record.exported_chats, 0),
    'export_events', coalesce(usage_record.export_events, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.consume_product_export_usage_daily(uuid, text, date, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_product_export_usage_daily(uuid, text, date, integer, integer, integer) to service_role;

create or replace function public.try_consume_product_edge_rate_limit(
  p_bucket_key text,
  p_product_slug text,
  p_increment integer,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  consumed boolean := false;
  normalized_increment integer := greatest(1, least(coalesce(p_increment, 1), 25));
  normalized_limit integer := greatest(1, coalesce(p_limit, 120));
  normalized_product_slug text := nullif(p_product_slug, '');
begin
  if nullif(p_bucket_key, '') is null or normalized_product_slug is null then
    return false;
  end if;

  insert into public.product_edge_rate_limits (
    bucket_key,
    product_slug,
    request_count
  )
  values (
    p_bucket_key,
    normalized_product_slug,
    normalized_increment
  )
  on conflict (bucket_key) do update
  set request_count = public.product_edge_rate_limits.request_count + excluded.request_count
  where public.product_edge_rate_limits.request_count + excluded.request_count <= normalized_limit;

  consumed := found;
  return consumed;
end;
$$;

revoke all on function public.try_consume_product_edge_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.try_consume_product_edge_rate_limit(text, text, integer, integer) to service_role;

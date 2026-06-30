create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  product_slug text not null default 'ai-chat-export',
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
  updated_at timestamptz not null default now()
);

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create table if not exists public.payment_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  product_slug text not null default 'ai-chat-export',
  provider_id text not null default 'paddle',
  paddle_customer_id text not null unique,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_payment_customers_updated_at on public.payment_customers;
create trigger set_payment_customers_updated_at
before update on public.payment_customers
for each row
execute function public.set_updated_at();

create table if not exists public.payment_subscriptions (
  paddle_subscription_id text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  product_slug text not null default 'ai-chat-export',
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

drop trigger if exists set_payment_subscriptions_updated_at on public.payment_subscriptions;
create trigger set_payment_subscriptions_updated_at
before update on public.payment_subscriptions
for each row
execute function public.set_updated_at();

create table if not exists public.payment_transactions (
  paddle_transaction_id text primary key,
  user_id uuid references public.profiles(id) on delete set null,
  product_slug text not null default 'ai-chat-export',
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

drop trigger if exists set_payment_transactions_updated_at on public.payment_transactions;
create trigger set_payment_transactions_updated_at
before update on public.payment_transactions
for each row
execute function public.set_updated_at();

create table if not exists public.payment_webhook_events (
  event_id text primary key,
  event_type text not null,
  product_slug text,
  provider_id text not null default 'paddle',
  paddle_customer_id text,
  paddle_subscription_id text,
  paddle_transaction_id text,
  paddle_price_id text,
  user_id uuid references public.profiles(id) on delete set null,
  processed boolean not null default false,
  ignored boolean not null default false,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.analytics_identities (
  guest_id text primary key,
  user_id uuid references public.profiles(id) on delete cascade,
  product_slug text not null default 'ai-chat-export',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_analytics_identities_updated_at on public.analytics_identities;
create trigger set_analytics_identities_updated_at
before update on public.analytics_identities
for each row
execute function public.set_updated_at();

create table if not exists public.analytics_events (
  id bigserial primary key,
  guest_id text,
  user_id uuid references public.profiles(id) on delete set null,
  product_slug text not null default 'ai-chat-export',
  event_name text not null,
  platform text not null default 'unknown',
  properties jsonb not null default '{}'::jsonb,
  client_timestamp timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists profiles_paddle_customer_id_idx on public.profiles(paddle_customer_id);
create index if not exists payment_customers_user_id_idx on public.payment_customers(user_id);
create index if not exists payment_subscriptions_user_id_idx on public.payment_subscriptions(user_id);
create index if not exists payment_subscriptions_customer_idx on public.payment_subscriptions(paddle_customer_id);
create index if not exists payment_transactions_user_id_idx on public.payment_transactions(user_id);
create index if not exists payment_webhook_events_user_id_idx on public.payment_webhook_events(user_id);
create index if not exists analytics_events_guest_id_idx on public.analytics_events(guest_id);
create index if not exists analytics_events_user_id_idx on public.analytics_events(user_id);
create index if not exists analytics_events_event_name_idx on public.analytics_events(event_name);

alter table public.profiles enable row level security;
alter table public.payment_customers enable row level security;
alter table public.payment_subscriptions enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.analytics_identities enable row level security;
alter table public.analytics_events enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

drop policy if exists "profiles_insert_own_free_only" on public.profiles;
create policy "profiles_insert_own_free_only"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id and plan = 'free');

grant usage on schema public to anon, authenticated;
grant select on public.profiles to authenticated;
grant insert on public.profiles to authenticated;

create or replace function public.handle_ai_chat_export_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update
  set email = excluded.email,
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_ai_chat_export_profile on auth.users;
create trigger on_auth_user_ai_chat_export_profile
after insert or update of email on auth.users
for each row execute function public.handle_ai_chat_export_user();

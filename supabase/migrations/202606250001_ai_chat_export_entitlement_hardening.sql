create table if not exists public.export_usage_daily (
  user_id uuid not null references public.profiles(id) on delete cascade,
  product_slug text not null default 'ai-chat-export',
  usage_date date not null default current_date,
  exported_chats integer not null default 0 check (exported_chats >= 0),
  export_events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, product_slug, usage_date)
);

drop trigger if exists set_export_usage_daily_updated_at on public.export_usage_daily;
create trigger set_export_usage_daily_updated_at
before update on public.export_usage_daily
for each row
execute function public.set_updated_at();

create index if not exists export_usage_daily_date_idx on public.export_usage_daily(usage_date);

alter table public.export_usage_daily enable row level security;

revoke all on public.payment_customers from anon, authenticated;
revoke all on public.payment_subscriptions from anon, authenticated;
revoke all on public.payment_transactions from anon, authenticated;
revoke all on public.payment_webhook_events from anon, authenticated;
revoke all on public.analytics_identities from anon, authenticated;
revoke all on public.analytics_events from anon, authenticated;
revoke all on public.export_usage_daily from anon, authenticated;

grant select on public.analytics_events to authenticated;
grant select on public.export_usage_daily to authenticated;

drop policy if exists "analytics_events_select_own" on public.analytics_events;
create policy "analytics_events_select_own"
on public.analytics_events
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "analytics_identities_no_client_access" on public.analytics_identities;
create policy "analytics_identities_no_client_access"
on public.analytics_identities
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "payment_customers_no_client_access" on public.payment_customers;
create policy "payment_customers_no_client_access"
on public.payment_customers
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "payment_subscriptions_no_client_access" on public.payment_subscriptions;
create policy "payment_subscriptions_no_client_access"
on public.payment_subscriptions
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "payment_transactions_no_client_access" on public.payment_transactions;
create policy "payment_transactions_no_client_access"
on public.payment_transactions
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "payment_webhook_events_no_client_access" on public.payment_webhook_events;
create policy "payment_webhook_events_no_client_access"
on public.payment_webhook_events
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "export_usage_daily_select_own" on public.export_usage_daily;
create policy "export_usage_daily_select_own"
on public.export_usage_daily
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "export_usage_daily_no_client_write" on public.export_usage_daily;
create policy "export_usage_daily_no_client_write"
on public.export_usage_daily
as restrictive
for insert
to anon, authenticated
with check (false);

drop policy if exists "export_usage_daily_no_client_update" on public.export_usage_daily;
create policy "export_usage_daily_no_client_update"
on public.export_usage_daily
as restrictive
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "export_usage_daily_no_client_delete" on public.export_usage_daily;
create policy "export_usage_daily_no_client_delete"
on public.export_usage_daily
as restrictive
for delete
to anon, authenticated
using (false);

drop policy if exists "analytics_events_no_client_insert" on public.analytics_events;
create policy "analytics_events_no_client_insert"
on public.analytics_events
as restrictive
for insert
to anon, authenticated
with check (false);

drop policy if exists "analytics_events_no_client_update" on public.analytics_events;
create policy "analytics_events_no_client_update"
on public.analytics_events
as restrictive
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "analytics_events_no_client_delete" on public.analytics_events;
create policy "analytics_events_no_client_delete"
on public.analytics_events
as restrictive
for delete
to anon, authenticated
using (false);

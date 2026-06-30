create table if not exists public.edge_rate_limits (
  bucket_key text primary key,
  product_slug text not null default 'ai-chat-export',
  request_count integer not null default 0 check (request_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_edge_rate_limits_updated_at on public.edge_rate_limits;
create trigger set_edge_rate_limits_updated_at
before update on public.edge_rate_limits
for each row
execute function public.set_updated_at();

alter table public.edge_rate_limits enable row level security;

revoke all on public.edge_rate_limits from anon, authenticated;

drop policy if exists "edge_rate_limits_no_client_access" on public.edge_rate_limits;
create policy "edge_rate_limits_no_client_access"
on public.edge_rate_limits
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

create or replace function public.consume_export_usage_daily(
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
  usage_record public.export_usage_daily%rowtype;
  consumed boolean := false;
  normalized_count integer := greatest(1, least(coalesce(p_requested_count, 1), 10));
  normalized_limit integer := greatest(0, coalesce(p_daily_limit, 0));
  event_payload jsonb := jsonb_build_array(jsonb_build_object('at', now(), 'count', greatest(1, least(coalesce(p_requested_count, 1), 10))));
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  if normalized_count <= normalized_limit then
    insert into public.export_usage_daily (
      user_id,
      product_slug,
      usage_date,
      exported_chats,
      export_events
    )
    values (
      p_user_id,
      coalesce(nullif(p_product_slug, ''), 'ai-chat-export'),
      p_usage_date,
      normalized_count,
      event_payload
    )
    on conflict (user_id, product_slug, usage_date) do update
    set exported_chats = public.export_usage_daily.exported_chats + excluded.exported_chats,
        export_events = (
          select coalesce(jsonb_agg(trimmed.value order by trimmed.ord), '[]'::jsonb)
          from (
            select events.value, events.ord
            from jsonb_array_elements(public.export_usage_daily.export_events || excluded.export_events)
              with ordinality as events(value, ord)
            order by events.ord desc
            limit greatest(1, coalesce(p_max_events, 50))
          ) as trimmed
        )
    where public.export_usage_daily.exported_chats + excluded.exported_chats <= normalized_limit
    returning * into usage_record;

    consumed := found;
  end if;

  if not consumed then
    select *
    into usage_record
    from public.export_usage_daily
    where user_id = p_user_id
      and product_slug = coalesce(nullif(p_product_slug, ''), 'ai-chat-export')
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

revoke all on function public.consume_export_usage_daily(uuid, text, date, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_export_usage_daily(uuid, text, date, integer, integer, integer) to service_role;

create or replace function public.try_consume_edge_rate_limit(
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
begin
  if nullif(p_bucket_key, '') is null then
    return false;
  end if;

  insert into public.edge_rate_limits (
    bucket_key,
    product_slug,
    request_count
  )
  values (
    p_bucket_key,
    coalesce(nullif(p_product_slug, ''), 'ai-chat-export'),
    normalized_increment
  )
  on conflict (bucket_key) do update
  set request_count = public.edge_rate_limits.request_count + excluded.request_count
  where public.edge_rate_limits.request_count + excluded.request_count <= normalized_limit;

  consumed := found;
  return consumed;
end;
$$;

revoke all on function public.try_consume_edge_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.try_consume_edge_rate_limit(text, text, integer, integer) to service_role;

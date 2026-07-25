-- Isolate Notion OAuth connections and authorization state by product while
-- preserving the legacy ChatVault Exporter behavior as ai-chat-export.

set lock_timeout = '5s';
set statement_timeout = '30s';

alter table public.notion_connections
  add column if not exists product_slug text not null default 'ai-chat-export';

alter table public.notion_oauth_states
  add column if not exists product_slug text not null default 'ai-chat-export';

-- Add the product-aware uniqueness rule while retaining the legacy
-- (chatvault_user_id, bot_id) rule. ChatVault Exporter's untouched callback
-- still uses those two columns as its PostgREST on_conflict target.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notion_connections'::regclass
      and conname = 'notion_connections_user_product_bot_key'
  ) then
    alter table public.notion_connections
      add constraint notion_connections_user_product_bot_key
      unique (chatvault_user_id, product_slug, bot_id);
  end if;
end;
$$;

create index if not exists notion_connections_user_product_idx
  on public.notion_connections(chatvault_user_id, product_slug, updated_at desc);

-- Replace the five-argument function with a six-argument version whose final
-- argument defaults to the legacy product. Keeping both overloads would make
-- five-argument calls ambiguous because the new argument has a default.
drop function if exists public.issue_notion_oauth_state(text, uuid, text, text, timestamptz);

create function public.issue_notion_oauth_state(
  p_state_hash text,
  p_user_id uuid,
  p_final_redirect_uri text,
  p_flow_challenge_hash text,
  p_expires_at timestamptz,
  p_product_slug text default 'ai-chat-export'
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  pending_count integer;
  normalized_product_slug text := coalesce(nullif(btrim(p_product_slug), ''), 'ai-chat-export');
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
    state_hash,
    chatvault_user_id,
    final_redirect_uri,
    flow_challenge_hash,
    expires_at,
    product_slug
  ) values (
    p_state_hash,
    p_user_id,
    p_final_redirect_uri,
    p_flow_challenge_hash,
    p_expires_at,
    normalized_product_slug
  );
  return true;
end;
$$;

drop function if exists public.consume_notion_oauth_state(text);

create function public.consume_notion_oauth_state(p_state_hash text)
returns table(
  chatvault_user_id uuid,
  final_redirect_uri text,
  flow_challenge_hash text,
  product_slug text
)
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
    notion_oauth_states.flow_challenge_hash,
    notion_oauth_states.product_slug;
end;
$$;

revoke all on function public.issue_notion_oauth_state(text, uuid, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.consume_notion_oauth_state(text)
  from public, anon, authenticated;
grant execute on function public.issue_notion_oauth_state(text, uuid, text, text, timestamptz, text)
  to service_role;
grant execute on function public.consume_notion_oauth_state(text)
  to service_role;

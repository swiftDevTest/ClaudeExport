-- Keep ChatVault Exporter's original per-user pending limits unchanged while
-- preventing pending flows from the new products from consuming that quota.

set lock_timeout = '5s';
set statement_timeout = '30s';

create or replace function public.issue_notion_oauth_state(
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
  advisory_key text;
begin
  if p_state_hash !~ '^[a-f0-9]{64}$' or p_flow_challenge_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' then
    return false;
  end if;
  advisory_key := case
    when normalized_product_slug = 'ai-chat-export' then p_user_id::text
    else p_user_id::text || ':' || normalized_product_slug
  end;
  perform pg_advisory_xact_lock(hashtext(advisory_key));
  delete from public.notion_oauth_states
  where ctid in (
    select ctid from public.notion_oauth_states
    where expires_at <= now()
    order by expires_at asc limit 100
  );
  select count(*) into pending_count
  from public.notion_oauth_states
  where chatvault_user_id = p_user_id
    and product_slug = normalized_product_slug
    and expires_at > now();
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
  target_product_slug text;
  advisory_key text;
begin
  if p_result_code_hash !~ '^[a-f0-9]{64}$' or p_flow_challenge_hash !~ '^[a-f0-9]{64}$'
     or p_expires_at <= now() or p_expires_at > now() + interval '5 minutes' then
    return false;
  end if;
  select product_slug into target_product_slug
  from public.notion_connections
  where id = p_connection_id
    and chatvault_user_id = p_user_id
    and status = 'pending_oauth';
  if target_product_slug is null then return false; end if;
  advisory_key := case
    when target_product_slug = 'ai-chat-export' then p_user_id::text
    else p_user_id::text || ':' || target_product_slug
  end;
  perform pg_advisory_xact_lock(hashtext(advisory_key));
  delete from public.notion_oauth_results
  where ctid in (
    select ctid from public.notion_oauth_results
    where expires_at <= now()
    order by expires_at asc limit 100
  );
  delete from public.notion_oauth_results
  where chatvault_user_id = p_user_id and connection_id = p_connection_id;
  select count(*) into pending_count
  from public.notion_oauth_results as result
  join public.notion_connections as connection on connection.id = result.connection_id
  where result.chatvault_user_id = p_user_id
    and connection.product_slug = target_product_slug
    and result.expires_at > now();
  if pending_count >= 5 then return false; end if;
  if not exists (
    select 1 from public.notion_connections
    where id = p_connection_id
      and chatvault_user_id = p_user_id
      and status = 'pending_oauth'
      and product_slug = target_product_slug
  ) then return false; end if;
  insert into public.notion_oauth_results (
    result_code_hash, chatvault_user_id, connection_id, flow_challenge_hash, expires_at
  ) values (
    p_result_code_hash, p_user_id, p_connection_id, p_flow_challenge_hash, p_expires_at
  );
  return true;
end;
$$;

revoke all on function public.issue_notion_oauth_state(text, uuid, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.issue_notion_oauth_result(text, uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.issue_notion_oauth_state(text, uuid, text, text, timestamptz, text)
  to service_role;
grant execute on function public.issue_notion_oauth_result(text, uuid, uuid, text, timestamptz)
  to service_role;

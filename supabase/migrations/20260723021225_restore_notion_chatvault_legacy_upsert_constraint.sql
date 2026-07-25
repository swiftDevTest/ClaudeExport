-- ChatVault Exporter's untouched notion-oauth callback upserts on
-- (chatvault_user_id, bot_id). Keep that conflict target valid alongside the
-- product-aware three-column constraint used by the new product callbacks.

set lock_timeout = '5s';
set statement_timeout = '30s';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notion_connections'::regclass
      and conname = 'notion_connections_chatvault_user_id_bot_id_key'
  ) then
    alter table public.notion_connections
      add constraint notion_connections_chatvault_user_id_bot_id_key
      unique (chatvault_user_id, bot_id);
  end if;
end;
$$;

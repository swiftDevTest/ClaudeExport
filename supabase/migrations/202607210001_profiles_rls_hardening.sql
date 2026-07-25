-- Profiles RLS Hardening
-- 修复 S3 漏洞：profiles 表存在客户端可 INSERT/UPDATE/DELETE 的 RLS 策略，
-- 攻击者可伪造 plan='pro' 字段绕过订阅校验。本迁移撤销客户端写权限并加 restrictive policy。

-- 1. 撤销 authenticated 角色对 profiles 的写权限（select 保留给 profiles_select_own）
revoke insert, update, delete on public.profiles from authenticated;
revoke insert, update, delete on public.profiles from anon;

-- 2. 删除存在漏洞的 insert 策略（原策略允许 authenticated 插入自己的行，但 with check 仅限 plan='free'，
--    攻击者可通过 security definer 触发器或直接 RPC 绕过）
drop policy if exists "profiles_insert_own_free_only" on public.profiles;

-- 3. 创建 restrictive 策略，显式拒绝客户端所有写操作
--    restrictive policy 与 permissive policy 取交集，即使存在其他 permissive policy 也无法通过
--    使用 drop if exists 保证幂等，兼容已被 20260716013901 部分应用的情况
drop policy if exists "profiles_no_client_insert" on public.profiles;
create policy "profiles_no_client_insert"
on public.profiles
as restrictive
for insert
to anon, authenticated
with check (false);

drop policy if exists "profiles_no_client_update" on public.profiles;
create policy "profiles_no_client_update"
on public.profiles
as restrictive
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "profiles_no_client_delete" on public.profiles;
create policy "profiles_no_client_delete"
on public.profiles
as restrictive
for delete
to anon, authenticated
using (false);

-- 4. 验证：确认 profiles_select_own 仍然可用（客户端可读自己的 profile）
do $$
begin
  assert exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'profiles_select_own'
  ), 'profiles_select_own policy must exist';
end $$;

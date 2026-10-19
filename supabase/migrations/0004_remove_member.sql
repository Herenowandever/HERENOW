-- HereNow 0004: remove people from the team.
-- Run this in the Supabase SQL editor after 0003.

-- Removes a person. If they have attendance records, they are hidden (deactivated) so past
-- reports and wage sheets stay correct. Someone with no records and no login is deleted outright.
-- Returns 'deleted' or 'deactivated'.
create or replace function public.remove_member(p_member uuid) returns text
language plpgsql security definer set search_path = public as $$
declare target profiles;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  select * into target from profiles where id = p_member and company_id = my_company_id();
  if target.id is null then raise exception 'NOT_FOUND'; end if;
  if p_member = auth.uid() then raise exception 'CANNOT_REMOVE_SELF'; end if;

  if not target.has_login and not exists (select 1 from attendance where user_id = p_member) then
    delete from profiles where id = p_member;
    return 'deleted';
  end if;

  update profiles set active = false where id = p_member;
  return 'deactivated';
end $$;

-- Brings a removed person back.
create or replace function public.restore_member(p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  update profiles set active = true where id = p_member and company_id = my_company_id();
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

revoke execute on function public.remove_member(uuid), public.restore_member(uuid) from public, anon;
grant execute on function public.remove_member(uuid), public.restore_member(uuid) to authenticated;

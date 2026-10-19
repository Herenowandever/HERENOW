-- HereNow 0003: site supervisors, workers without a phone, crew marking, half days and daily wages.
-- Run this in the Supabase SQL editor after 0001 and 0002.

------------------------------------------------------------------------------
-- People: supervisors, workers without a login, site and wage
------------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'supervisor', 'employee'));

-- Workers without a phone have a profile but no login.
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();
alter table public.profiles add column if not exists has_login boolean not null default true;
alter table public.profiles add column if not exists office_id uuid references public.offices on delete set null;
alter table public.profiles add column if not exists daily_wage numeric(10,2) check (daily_wage >= 0);
alter table public.profiles add column if not exists ot_hourly_rate numeric(10,2) check (ot_hourly_rate >= 0);
create index if not exists profiles_office_idx on public.profiles (office_id);

-- If a login is deleted, keep the person's attendance history and mark them inactive.
create or replace function public.on_auth_user_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update profiles set has_login = false, active = false where id = old.id;
  return old;
end $$;
drop trigger if exists herenow_auth_user_deleted on auth.users;
create trigger herenow_auth_user_deleted after delete on auth.users
  for each row execute function public.on_auth_user_deleted();

------------------------------------------------------------------------------
-- Attendance: who marked it, crew photo, half days
------------------------------------------------------------------------------

alter table public.attendance drop constraint if exists attendance_in_method_check;
alter table public.attendance drop constraint if exists attendance_out_method_check;
alter table public.attendance add constraint attendance_in_method_check check (in_method in ('gps', 'qr', 'crew', 'manual'));
alter table public.attendance add constraint attendance_out_method_check check (out_method in ('gps', 'qr', 'crew', 'manual'));
alter table public.attendance add column if not exists marked_by uuid references public.profiles on delete set null;
alter table public.attendance add column if not exists out_marked_by uuid references public.profiles on delete set null;
alter table public.attendance add column if not exists group_photo_path text;
alter table public.attendance add column if not exists day_status text check (day_status in ('full', 'half'));

------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function public.my_office_id() returns uuid
language sql stable security definer set search_path = public as $$
  select office_id from profiles where id = auth.uid() and active
$$;

-- Can the signed-in person see this person's records? Admins: whole company. Supervisors: their site.
create or replace function public.can_view_person(p_person uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles me join profiles p on p.company_id = me.company_id
    where me.id = auth.uid() and me.active and p.id = p_person
      and (me.id = p.id or me.role = 'admin'
           or (me.role = 'supervisor' and me.office_id is not null and p.office_id = me.office_id))
  )
$$;

-- Minutes after shift start, wrapped to -12h..+12h so night shifts work across midnight.
create or replace function public.is_late_at(p_local timestamp, p_start time, p_grace int) returns boolean
language plpgsql immutable as $$
declare m double precision;
begin
  if p_start is null then return false; end if;
  m := extract(epoch from (p_local::time - p_start)) / 60;
  if m > 720 then m := m - 1440; elsif m < -720 then m := m + 1440; end if;
  return m > coalesce(p_grace, 0);
end $$;

------------------------------------------------------------------------------
-- Visibility for supervisors
------------------------------------------------------------------------------

drop policy if exists "read own profile, admins read team" on public.profiles;
drop policy if exists "read own profile; admins and supervisors read their people" on public.profiles;
create policy "read own profile; admins and supervisors read their people" on public.profiles
  for select using (company_id = public.my_company_id() and public.can_view_person(id) or id = auth.uid());

drop policy if exists "read own attendance, admins read team" on public.attendance;
drop policy if exists "read own attendance; admins and supervisors read their people" on public.attendance;
create policy "read own attendance; admins and supervisors read their people" on public.attendance
  for select using (company_id = public.my_company_id() and public.can_view_person(user_id));

------------------------------------------------------------------------------
-- Managing people
------------------------------------------------------------------------------

drop function if exists public.update_member(uuid, text, uuid, text, boolean);
create or replace function public.update_member(p_member uuid, p_role text, p_shift uuid, p_job_title text,
  p_active boolean, p_office uuid default null, p_daily_wage numeric default null, p_ot_rate numeric default null,
  p_full_name text default null)
returns void language plpgsql security definer set search_path = public as $$
declare target profiles;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  select * into target from profiles where id = p_member and company_id = my_company_id();
  if target.id is null then raise exception 'NOT_FOUND'; end if;
  if p_shift is not null and not exists (select 1 from shifts where id = p_shift and company_id = my_company_id()) then
    raise exception 'NOT_FOUND'; end if;
  if p_office is not null and not exists (select 1 from offices where id = p_office and company_id = my_company_id()) then
    raise exception 'NOT_FOUND'; end if;
  if p_role not in ('admin', 'supervisor', 'employee') then raise exception 'BAD_ROLE'; end if;
  if not target.has_login and p_role <> 'employee' then raise exception 'NEEDS_LOGIN'; end if;
  if p_role = 'supervisor' and p_office is null then raise exception 'SUPERVISOR_NEEDS_SITE'; end if;
  if p_member = auth.uid() and (p_role <> 'admin' or not p_active) then raise exception 'CANNOT_DEMOTE_SELF'; end if;
  update profiles set
    role = p_role, shift_id = p_shift, job_title = nullif(trim(p_job_title), ''), active = p_active,
    office_id = p_office, daily_wage = p_daily_wage, ot_hourly_rate = p_ot_rate,
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name)
  where id = p_member;
end $$;

-- Adds a worker who has no phone. Supervisors and admins mark their attendance.
create or replace function public.add_worker(p_full_name text, p_job_title text default null, p_shift uuid default null,
  p_office uuid default null, p_daily_wage numeric default null, p_ot_rate numeric default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if p_shift is not null and not exists (select 1 from shifts where id = p_shift and company_id = my_company_id()) then
    raise exception 'NOT_FOUND'; end if;
  if p_office is not null and not exists (select 1 from offices where id = p_office and company_id = my_company_id()) then
    raise exception 'NOT_FOUND'; end if;
  insert into profiles (company_id, full_name, job_title, role, shift_id, office_id, daily_wage, ot_hourly_rate, has_login)
  values (my_company_id(), trim(p_full_name), nullif(trim(p_job_title), ''), 'employee', p_shift, p_office,
          p_daily_wage, p_ot_rate, false)
  returning id into new_id;
  return new_id;
end $$;

------------------------------------------------------------------------------
-- Crew marking
------------------------------------------------------------------------------

-- A supervisor (on site, with a group photo) or an admin marks several people in or out at once.
create or replace function public.crew_mark(p_people uuid[], p_kind text,
  p_lat double precision default null, p_lng double precision default null, p_accuracy double precision default null,
  p_qr text default null, p_photo_path text default null)
returns table (person uuid, full_name text, result text)
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles; tz text; local_now timestamp; d date; v record; method text; site uuid; dist double precision;
  p profiles; sh shifts; rec attendance;
begin
  select * into me from profiles where id = auth.uid() and active;
  if me.id is null then raise exception 'NOT_A_MEMBER'; end if;
  if me.role not in ('admin', 'supervisor') then raise exception 'SUPERVISOR_ONLY'; end if;
  if p_kind not in ('in', 'out') then raise exception 'BAD_REQUEST'; end if;
  if coalesce(array_length(p_people, 1), 0) = 0 then raise exception 'NOBODY_SELECTED'; end if;
  if array_length(p_people, 1) > 200 then raise exception 'TOO_MANY'; end if;
  select timezone into tz from companies where id = me.company_id;
  local_now := now() at time zone tz;
  d := local_now::date;

  if p_photo_path is not null and p_photo_path not like me.company_id::text || '/' || me.id::text || '/%' then
    raise exception 'NEEDS_PHOTO'; end if;

  if me.role = 'supervisor' then
    if me.office_id is null then raise exception 'SUPERVISOR_NEEDS_SITE'; end if;
    if p_photo_path is null then raise exception 'NEEDS_PHOTO'; end if;
    select * into v from verify_presence(me.company_id, d, p_lat, p_lng, p_accuracy, p_qr);
    if v.office_id <> me.office_id then raise exception 'WRONG_SITE'; end if;
    dist := v.distance;
    method := 'crew';
    site := me.office_id;
  else
    -- Admins can record attendance from anywhere; it's labelled as a manual entry.
    method := 'manual';
    site := null;
  end if;

  for p in select * from profiles where id = any(p_people) order by profiles.full_name loop
    person := p.id;
    full_name := p.full_name;
    if p.company_id <> me.company_id or not p.active
       or (me.role = 'supervisor' and p.office_id is distinct from me.office_id) then
      result := 'not_allowed';
      return next;
      continue;
    end if;

    if p_kind = 'in' then
      if exists (select 1 from attendance a where a.user_id = p.id and a.clock_out_at is null
                 and a.clock_in_at > now() - interval '20 hours') then
        result := 'already_in';
      elsif exists (select 1 from attendance a where a.user_id = p.id and a.work_date = d) then
        result := 'already_done';
      else
        select * into sh from shifts where id = p.shift_id;
        insert into attendance (company_id, user_id, work_date, office_id, in_method, in_lat, in_lng, in_accuracy_m,
            in_distance_m, shift_id, shift_start, shift_end, is_late, marked_by, group_photo_path)
        values (me.company_id, p.id, d, coalesce(site, p.office_id), method, p_lat, p_lng, p_accuracy,
            dist, sh.id, sh.start_time, sh.end_time,
            is_late_at(local_now, sh.start_time, sh.grace_minutes), me.id, p_photo_path)
        returning * into rec;
        result := case when rec.is_late then 'late' else 'ok' end;
      end if;
    else
      select * into rec from attendance a where a.user_id = p.id and a.clock_out_at is null
        and a.clock_in_at > now() - interval '20 hours' order by a.clock_in_at desc limit 1;
      if rec.id is null then
        result := 'not_in';
      else
        update attendance set clock_out_at = greatest(now(), clock_in_at + interval '1 second'), out_method = method,
            out_lat = p_lat, out_lng = p_lng, out_accuracy_m = p_accuracy, out_marked_by = me.id
          where id = rec.id;
        result := 'ok';
      end if;
    end if;
    return next;
  end loop;
end $$;

-- Admins can mark a day as a full day or half day (null = work it out from the hours).
create or replace function public.set_day_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if p_status is not null and p_status not in ('full', 'half') then raise exception 'BAD_REQUEST'; end if;
  update attendance set day_status = p_status, edited_by = auth.uid() where id = p_id and company_id = my_company_id();
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

------------------------------------------------------------------------------
-- Wage sheet
------------------------------------------------------------------------------

-- Full days pay the daily wage, half days pay half. Overtime is time beyond the shift length,
-- paid at the person's overtime rate, or their daily wage divided by shift hours if no rate is set.
-- A day with no clock-out counts as a full day (and is flagged) unless an admin changes it.
create or replace function public.wage_sheet(p_month date)
returns table (user_id uuid, full_name text, job_title text, site_name text, active boolean,
               daily_wage numeric, ot_hourly_rate numeric, full_days int, half_days int, no_clock_out_days int,
               ot_hours numeric, base_pay numeric, ot_pay numeric, total_pay numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  return query
  with a as (
    select at.user_id,
      extract(epoch from (at.clock_out_at - at.clock_in_at)) / 3600.0 as worked,
      at.clock_out_at is null as open_day,
      at.day_status,
      case when at.shift_start is null then 8.0
           else extract(epoch from (at.shift_end - at.shift_start)) / 3600.0
                + case when at.shift_end <= at.shift_start then 24 else 0 end end as shift_len
    from attendance at
    where at.company_id = my_company_id()
      and at.work_date >= date_trunc('month', p_month)::date
      and at.work_date <  (date_trunc('month', p_month) + interval '1 month')::date
  ), b as (
    select a.*,
      coalesce(a.day_status, case when a.open_day then 'full' when a.worked < a.shift_len / 2 then 'half' else 'full' end) as status,
      case when a.open_day then 0 else greatest(a.worked - a.shift_len, 0) end as ot
    from a
  ), per as (
    select b.user_id,
      count(*) filter (where b.status = 'full')::int as full_days,
      count(*) filter (where b.status = 'half')::int as half_days,
      count(*) filter (where b.open_day)::int as no_out,
      sum(b.ot) as ot_h,
      avg(b.shift_len) as avg_len
    from b group by b.user_id
  )
  select p.id, p.full_name, p.job_title, o.name, p.active, p.daily_wage, p.ot_hourly_rate,
    coalesce(per.full_days, 0), coalesce(per.half_days, 0), coalesce(per.no_out, 0),
    round(coalesce(per.ot_h, 0)::numeric, 2),
    round(coalesce(p.daily_wage, 0) * (coalesce(per.full_days, 0) + coalesce(per.half_days, 0) * 0.5), 2),
    round(coalesce(per.ot_h, 0)::numeric * coalesce(p.ot_hourly_rate, coalesce(p.daily_wage, 0) / nullif(per.avg_len, 0)::numeric, 0), 2),
    round(coalesce(p.daily_wage, 0) * (coalesce(per.full_days, 0) + coalesce(per.half_days, 0) * 0.5)
      + coalesce(per.ot_h, 0)::numeric * coalesce(p.ot_hourly_rate, coalesce(p.daily_wage, 0) / nullif(per.avg_len, 0)::numeric, 0), 2)
  from profiles p
  left join offices o on o.id = p.office_id
  left join per on per.user_id = p.id
  where p.company_id = my_company_id() and (p.active or per.user_id is not null)
  order by p.full_name;
end $$;

------------------------------------------------------------------------------
-- Permissions
------------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.my_role(), public.my_office_id(), public.can_view_person(uuid),
  public.update_member(uuid, text, uuid, text, boolean, uuid, numeric, numeric, text),
  public.add_worker(text, text, uuid, uuid, numeric, numeric),
  public.crew_mark(uuid[], text, double precision, double precision, double precision, text, text),
  public.set_day_status(uuid, text), public.wage_sheet(date)
to authenticated;

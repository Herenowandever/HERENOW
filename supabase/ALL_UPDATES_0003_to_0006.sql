-- Musterly: all database updates after the first setup (0003 to 0006) in one file.
-- Safe to run more than once. Paste the whole file into Supabase → SQL Editor → New query, then click Run.


-- ====================================================================
-- 0003_crews_and_wages.sql
-- ====================================================================
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

-- ====================================================================
-- 0004_remove_member.sql
-- ====================================================================
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

-- ====================================================================
-- 0005_pay_rules.sql
-- ====================================================================
-- HereNow 0005: company work rules, holidays, monthly-salary staff, advances and deductions,
-- and a wage sheet for any period (week or month).
-- Run this in the Supabase SQL editor after 0004.

------------------------------------------------------------------------------
-- Company rules
------------------------------------------------------------------------------

alter table public.companies
  add column if not exists weekly_offs smallint[] not null default '{0}',          -- 0 = Sunday … 6 = Saturday
  add column if not exists paid_weekly_off boolean not null default false,         -- for daily-wage staff
  add column if not exists paid_holidays boolean not null default false,           -- for daily-wage staff
  add column if not exists half_day_hours numeric(4,2) check (half_day_hours > 0 and half_day_hours < 24), -- null = half the shift
  add column if not exists ot_after_minutes int not null default 30 check (ot_after_minutes between 0 and 600),
  add column if not exists ot_multiplier numeric(4,2) not null default 1.0 check (ot_multiplier between 0 and 5),
  add column if not exists pay_cycle text not null default 'monthly' check (pay_cycle in ('monthly', 'weekly')),
  add column if not exists week_starts smallint not null default 1 check (week_starts between 0 and 6);

alter table public.companies drop constraint if exists companies_weekly_offs_check;
alter table public.companies add constraint companies_weekly_offs_check
  check (weekly_offs <@ array[0,1,2,3,4,5,6]::smallint[] and cardinality(weekly_offs) < 7);

grant update (name, timezone, weekly_offs, paid_weekly_off, paid_holidays, half_day_hours, ot_after_minutes,
  ot_multiplier, pay_cycle, week_starts) on public.companies to authenticated;

create table if not exists public.holidays (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies on delete cascade,
  day         date not null,
  name        text not null check (length(trim(name)) between 1 and 80),
  unique (company_id, day)
);
alter table public.holidays enable row level security;
drop policy if exists "members read holidays" on public.holidays;
create policy "members read holidays" on public.holidays for select using (company_id = public.my_company_id());
drop policy if exists "admins manage holidays" on public.holidays;
create policy "admins manage holidays" on public.holidays for all
  using (company_id = public.my_company_id() and public.is_admin())
  with check (company_id = public.my_company_id() and public.is_admin());
grant select, insert, update, delete on public.holidays to authenticated;

------------------------------------------------------------------------------
-- Pay type per person
------------------------------------------------------------------------------

alter table public.profiles
  add column if not exists pay_type text not null default 'daily' check (pay_type in ('daily', 'monthly')),
  add column if not exists monthly_salary numeric(12,2) check (monthly_salary >= 0);

drop function if exists public.update_member(uuid, text, uuid, text, boolean, uuid, numeric, numeric, text);
create or replace function public.update_member(p_member uuid, p_role text, p_shift uuid, p_job_title text,
  p_active boolean, p_office uuid default null, p_daily_wage numeric default null, p_ot_rate numeric default null,
  p_full_name text default null, p_pay_type text default null, p_monthly_salary numeric default null)
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
  if p_pay_type is not null and p_pay_type not in ('daily', 'monthly') then raise exception 'BAD_REQUEST'; end if;
  if not target.has_login and p_role <> 'employee' then raise exception 'NEEDS_LOGIN'; end if;
  if p_role = 'supervisor' and p_office is null then raise exception 'SUPERVISOR_NEEDS_SITE'; end if;
  if p_member = auth.uid() and (p_role <> 'admin' or not p_active) then raise exception 'CANNOT_DEMOTE_SELF'; end if;
  update profiles set
    role = p_role, shift_id = p_shift, job_title = nullif(trim(p_job_title), ''), active = p_active,
    office_id = p_office, daily_wage = p_daily_wage, ot_hourly_rate = p_ot_rate,
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
    pay_type = coalesce(p_pay_type, pay_type),
    monthly_salary = case when p_pay_type is null then monthly_salary else p_monthly_salary end
  where id = p_member;
end $$;

------------------------------------------------------------------------------
-- Advances, deductions and bonuses
------------------------------------------------------------------------------

create table if not exists public.pay_adjustments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade,
  day         date not null,
  kind        text not null check (kind in ('advance', 'deduction', 'bonus')),
  amount      numeric(10,2) not null check (amount > 0),
  note        text check (length(note) <= 200),
  created_by  uuid references public.profiles on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists pay_adjustments_company_day on public.pay_adjustments (company_id, day);
alter table public.pay_adjustments enable row level security;
drop policy if exists "read own adjustments, admins read all" on public.pay_adjustments;
create policy "read own adjustments, admins read all" on public.pay_adjustments for select
  using (company_id = public.my_company_id() and (user_id = auth.uid() or public.is_admin()));
drop policy if exists "admins manage adjustments" on public.pay_adjustments;
create policy "admins manage adjustments" on public.pay_adjustments for all
  using (company_id = public.my_company_id() and public.is_admin())
  with check (company_id = public.my_company_id() and public.is_admin()
              and exists (select 1 from public.profiles p where p.id = user_id and p.company_id = public.my_company_id()));
grant select, insert, update, delete on public.pay_adjustments to authenticated;

create or replace function public.pay_adjustments_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := auth.uid();
  return new;
end $$;
drop trigger if exists pay_adjustments_fill on public.pay_adjustments;
create trigger pay_adjustments_fill before insert on public.pay_adjustments
  for each row execute function public.pay_adjustments_fill();

------------------------------------------------------------------------------
-- Wage sheet for any period
------------------------------------------------------------------------------
-- For every person and every day in the period (up to today, from the day they joined):
--   worked day:  full = 1 day's pay, half = ½ (under the half-day cut-off)
--   weekly off / holiday not worked: paid for monthly staff; for daily staff only if the company pays them
--   working day not worked: absent, unpaid
-- Day rate: daily wage, or monthly salary ÷ days in that month.
-- Overtime: time beyond the shift, counted only when it's at least the company's minimum,
-- paid at the person's overtime rate, or (day rate ÷ shift hours) × the company's multiplier.
create or replace function public.wage_sheet_range(p_from date, p_to date)
returns table (user_id uuid, full_name text, job_title text, site_name text, active boolean, pay_type text,
               daily_wage numeric, monthly_salary numeric, worked_days numeric, full_days int, half_days int,
               absent_days int, paid_off_days int, no_clock_out_days int, ot_hours numeric,
               base_pay numeric, ot_pay numeric, bonus numeric, advances numeric, deductions numeric, net_pay numeric)
language plpgsql stable security definer set search_path = public as $$
declare co companies; last_day date;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if p_to < p_from or p_to - p_from > 62 then raise exception 'BAD_PERIOD'; end if;
  select * into co from companies where id = my_company_id();
  last_day := least(p_to, (now() at time zone co.timezone)::date);

  return query
  with days as (
    select d::date as day,
      extract(dow from d)::smallint = any(co.weekly_offs) as is_off,
      exists (select 1 from holidays h where h.company_id = co.id and h.day = d::date) as is_holiday,
      extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))::numeric as month_days
    from generate_series(p_from, last_day, interval '1 day') d
  ),
  people as (
    select p.* from profiles p
    where p.company_id = co.id
      and (p.active or exists (select 1 from attendance a where a.user_id = p.id and a.work_date between p_from and p_to))
  ),
  rec as (
    select a.user_id, a.work_date,
      a.clock_out_at is null as open_day,
      extract(epoch from (a.clock_out_at - a.clock_in_at)) / 3600.0 as worked,
      case when a.shift_start is null then 8.0
           else extract(epoch from (a.shift_end - a.shift_start)) / 3600.0
                + case when a.shift_end <= a.shift_start then 24 else 0 end end as shift_len,
      a.day_status
    from attendance a
    where a.company_id = co.id and a.work_date between p_from and p_to
  ),
  grid as (
    select pp.id as uid, pp.pay_type as ptype, pp.daily_wage as dw, pp.monthly_salary as ms, pp.ot_hourly_rate as otr,
      dd.day, dd.is_off, dd.is_holiday,
      case when pp.pay_type = 'monthly' then coalesce(pp.monthly_salary, 0) / dd.month_days else coalesce(pp.daily_wage, 0) end as day_rate,
      r.open_day, r.worked, r.shift_len,
      case when r.user_id is null then null
           else coalesce(r.day_status,
             case when r.open_day then 'full'
                  when r.worked < coalesce(co.half_day_hours, r.shift_len / 2) then 'half'
                  else 'full' end) end as status
    from people pp
    cross join days dd
    left join rec r on r.user_id = pp.id and r.work_date = dd.day
    where dd.day >= (pp.created_at at time zone co.timezone)::date
  ),
  scored as (
    select g.*,
      case when g.status = 'full' then 1.0
           when g.status = 'half' then 0.5
           when g.is_off and (g.ptype = 'monthly' or co.paid_weekly_off) then 1.0
           when g.is_holiday and not g.is_off and (g.ptype = 'monthly' or co.paid_holidays) then 1.0
           else 0 end as paid_fraction,
      case when g.status is null and (g.is_off or g.is_holiday)
                and ((g.is_off and (g.ptype = 'monthly' or co.paid_weekly_off))
                     or (g.is_holiday and (g.ptype = 'monthly' or co.paid_holidays))) then 1 else 0 end as paid_off,
      case when g.status is null and not g.is_off and not g.is_holiday then 1 else 0 end as absent,
      case when g.open_day or g.worked is null then 0
           when (g.worked - g.shift_len) * 60 >= co.ot_after_minutes then greatest(g.worked - g.shift_len, 0)
           else 0 end as ot
    from grid g
  ),
  per as (
    select s.uid,
      count(*) filter (where s.status = 'full')::int as full_days,
      count(*) filter (where s.status = 'half')::int as half_days,
      sum(s.absent)::int as absent_days,
      sum(s.paid_off)::int as paid_off_days,
      count(*) filter (where s.open_day)::int as open_days,
      sum(s.ot) as ot_h,
      sum(s.day_rate * s.paid_fraction) as base,
      sum(s.ot * coalesce(s.otr, s.day_rate / nullif(s.shift_len, 0) * co.ot_multiplier)) as ot_amt
    from scored s group by s.uid
  ),
  adj as (
    select pa.user_id as uid,
      coalesce(sum(pa.amount) filter (where pa.kind = 'bonus'), 0) as bonus,
      coalesce(sum(pa.amount) filter (where pa.kind = 'advance'), 0) as advances,
      coalesce(sum(pa.amount) filter (where pa.kind = 'deduction'), 0) as deductions
    from pay_adjustments pa
    where pa.company_id = co.id and pa.day between p_from and p_to
    group by pa.user_id
  )
  select pp.id, pp.full_name, pp.job_title, o.name, pp.active, pp.pay_type, pp.daily_wage, pp.monthly_salary,
    (coalesce(per.full_days, 0) + coalesce(per.half_days, 0) * 0.5)::numeric,
    coalesce(per.full_days, 0), coalesce(per.half_days, 0), coalesce(per.absent_days, 0),
    coalesce(per.paid_off_days, 0), coalesce(per.open_days, 0),
    round(coalesce(per.ot_h, 0)::numeric, 2),
    round(coalesce(per.base, 0)::numeric, 2),
    round(coalesce(per.ot_amt, 0)::numeric, 2),
    coalesce(adj.bonus, 0), coalesce(adj.advances, 0), coalesce(adj.deductions, 0),
    round((coalesce(per.base, 0) + coalesce(per.ot_amt, 0))::numeric
          + coalesce(adj.bonus, 0) - coalesce(adj.advances, 0) - coalesce(adj.deductions, 0), 2)
  from people pp
  left join offices o on o.id = pp.office_id
  left join per on per.uid = pp.id
  left join adj on adj.uid = pp.id
  order by pp.full_name;
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.update_member(uuid, text, uuid, text, boolean, uuid, numeric, numeric, text, text, numeric),
  public.wage_sheet_range(date, date)
to authenticated;

-- ====================================================================
-- 0006_safety.sql
-- ====================================================================
-- HereNow 0006: approving new members, photo retention, activity log, and two-step login for admins.
-- Run this in the Supabase SQL editor after 0005.

------------------------------------------------------------------------------
-- Company settings
------------------------------------------------------------------------------

alter table public.companies
  add column if not exists require_approval boolean not null default true,
  add column if not exists photo_retention_days int not null default 90 check (photo_retention_days between 7 and 3650),
  add column if not exists require_admin_mfa boolean not null default false;

grant update (require_approval, photo_retention_days, require_admin_mfa) on public.companies to authenticated;

------------------------------------------------------------------------------
-- Two-step login: an admin who has set up an authenticator app only counts as an admin
-- once they've entered a code this session (assurance level aal2). If the company requires
-- two-step login, admins without it set up don't count as admins until they set it up.
------------------------------------------------------------------------------

create or replace function public.has_verified_mfa() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified')
$$;

create or replace function public.session_aal() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1')
$$;

create or replace function public.is_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare me profiles; req boolean;
begin
  select * into me from profiles where id = auth.uid() and active;
  if me.id is null or me.role <> 'admin' then return false; end if;
  if has_verified_mfa() then return session_aal() = 'aal2'; end if;
  select require_admin_mfa into req from companies where id = me.company_id;
  return not coalesce(req, false);
end $$;

-- Tells the app what the signed-in admin still needs to do.
create or replace function public.my_security_state() returns table (role text, has_mfa boolean, aal text, company_requires_mfa boolean)
language sql stable security definer set search_path = public as $$
  select p.role, has_verified_mfa(), session_aal(), c.require_admin_mfa
  from profiles p join companies c on c.id = p.company_id
  where p.id = auth.uid()
$$;

-- Supervisors see their site; admins (with two-step done, if set up) see everyone.
create or replace function public.can_view_person(p_person uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles me join profiles p on p.company_id = me.company_id
    where me.id = auth.uid() and me.active and p.id = p_person
      and (me.id = p.id or public.is_admin()
           or (me.role = 'supervisor' and me.office_id is not null and p.office_id = me.office_id))
  )
$$;

------------------------------------------------------------------------------
-- Approving new members
------------------------------------------------------------------------------

alter table public.profiles add column if not exists approved boolean not null default true;

-- Joining with a code: if the company requires approval, the person waits (inactive, not approved).
create or replace function public.join_company(p_join_code text, p_full_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare c companies; s uuid;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN'; end if;
  if exists (select 1 from profiles where id = auth.uid()) then raise exception 'ALREADY_IN_COMPANY'; end if;
  select * into c from companies where join_code = upper(trim(p_join_code));
  if c.id is null then raise exception 'BAD_JOIN_CODE'; end if;
  select id into s from shifts where company_id = c.id order by created_at limit 1;
  insert into profiles (id, company_id, full_name, shift_id, active, approved)
  values (auth.uid(), c.id, trim(p_full_name), s, not c.require_approval, not c.require_approval);
  return c.id;
end $$;

-- What a person waiting for approval can see about the company they asked to join.
create or replace function public.my_pending_company() returns text
language sql stable security definer set search_path = public as $$
  select c.name from profiles p join companies c on c.id = p.company_id
  where p.id = auth.uid() and not p.approved
$$;

-- Admins can list people waiting for approval (they're inactive, so ordinary policies hide them).
create or replace function public.pending_members()
returns table (id uuid, full_name text, email text, requested_at timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  return query
  select p.id, p.full_name, u.email::text, p.created_at
  from profiles p left join auth.users u on u.id = p.id
  where p.company_id = my_company_id() and not p.approved
  order by p.created_at;
end $$;

create or replace function public.approve_member(p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  update profiles set approved = true, active = true where id = p_member and company_id = my_company_id() and not approved;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

-- Turns down a request. The person can ask again with the code later.
create or replace function public.reject_member(p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  delete from profiles where id = p_member and company_id = my_company_id() and not approved;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

-- Lets someone whose request was turned down (or who picked the wrong company) start over.
create or replace function public.cancel_join_request() returns void
language sql security definer set search_path = public as $$
  delete from profiles where id = auth.uid() and not approved
$$;

------------------------------------------------------------------------------
-- Activity log
------------------------------------------------------------------------------

create table if not exists public.activity_log (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies on delete cascade,
  actor       uuid,
  action      text not null,
  person      uuid,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists activity_log_company_time on public.activity_log (company_id, created_at desc);
alter table public.activity_log enable row level security;
drop policy if exists "admins read activity" on public.activity_log;
create policy "admins read activity" on public.activity_log for select
  using (company_id = public.my_company_id() and public.is_admin());
grant select on public.activity_log to authenticated;
revoke insert, update, delete on public.activity_log from anon, authenticated;

create or replace function public.log_activity(p_company uuid, p_action text, p_person uuid, p_details jsonb)
returns void language sql security definer set search_path = public as $$
  -- Skipped when the company itself is being deleted.
  insert into activity_log (company_id, actor, action, person, details)
  select p_company, auth.uid(), p_action, p_person, p_details
  where exists (select 1 from companies where id = p_company)
$$;
revoke execute on function public.log_activity(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Collects {column: [old, new]} for the listed columns that changed.
create or replace function public.changed_fields(p_old jsonb, p_new jsonb, p_cols text[]) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(c, jsonb_build_array(p_old -> c, p_new -> c)), '{}'::jsonb)
  from unnest(p_cols) c
  where (p_old -> c) is distinct from (p_new -> c)
$$;

create or replace function public.audit_profiles() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  if tg_op = 'INSERT' then
    perform log_activity(new.company_id, case when new.approved then 'person.added' else 'person.requested' end, new.id,
      jsonb_build_object('name', new.full_name, 'has_login', new.has_login));
    return new;
  elsif tg_op = 'DELETE' then
    perform log_activity(old.company_id, case when old.approved then 'person.deleted' else 'person.rejected' end, null,
      jsonb_build_object('name', old.full_name));
    return old;
  end if;
  d := changed_fields(to_jsonb(old), to_jsonb(new),
    array['full_name','job_title','role','shift_id','office_id','daily_wage','ot_hourly_rate','pay_type','monthly_salary','active','approved']);
  if d <> '{}'::jsonb then
    perform log_activity(new.company_id,
      case when d ? 'approved' then 'person.approved'
           when d ? 'active' and not new.active then 'person.removed'
           when d ? 'active' and new.active then 'person.restored'
           else 'person.updated' end,
      new.id, d || jsonb_build_object('name', new.full_name));
  end if;
  return new;
end $$;
drop trigger if exists audit_profiles on public.profiles;
create trigger audit_profiles after insert or update or delete on public.profiles
  for each row execute function public.audit_profiles();

-- Only edits to existing times and full/half-day changes are logged, not normal clocking in and out.
create or replace function public.audit_attendance() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  if old.clock_in_at is distinct from new.clock_in_at
     or (old.clock_out_at is not null and old.clock_out_at is distinct from new.clock_out_at)
     or old.day_status is distinct from new.day_status then
    d := changed_fields(to_jsonb(old), to_jsonb(new), array['clock_in_at','clock_out_at','day_status']);
    perform log_activity(new.company_id, 'attendance.edited', new.user_id, d || jsonb_build_object('date', new.work_date));
  end if;
  return new;
end $$;
drop trigger if exists audit_attendance on public.attendance;
create trigger audit_attendance after update on public.attendance
  for each row execute function public.audit_attendance();

create or replace function public.audit_pay_adjustments() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform log_activity(new.company_id, 'pay.' || new.kind || '.added', new.user_id,
      jsonb_build_object('amount', new.amount, 'date', new.day, 'note', new.note));
    return new;
  end if;
  perform log_activity(old.company_id, 'pay.' || old.kind || '.deleted', old.user_id,
    jsonb_build_object('amount', old.amount, 'date', old.day, 'note', old.note));
  return old;
end $$;
drop trigger if exists audit_pay_adjustments on public.pay_adjustments;
create trigger audit_pay_adjustments after insert or delete on public.pay_adjustments
  for each row execute function public.audit_pay_adjustments();

create or replace function public.audit_settings() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb; cid uuid;
begin
  if tg_table_name = 'companies' then
    d := changed_fields(to_jsonb(old), to_jsonb(new), array['name','timezone','weekly_offs','paid_weekly_off','paid_holidays',
      'half_day_hours','ot_after_minutes','ot_multiplier','pay_cycle','week_starts','require_approval','photo_retention_days',
      'require_admin_mfa']);
    if old.join_code is distinct from new.join_code then d := d || jsonb_build_object('join_code', 'changed'); end if;
    if d <> '{}'::jsonb then perform log_activity(new.id, 'company.updated', null, d); end if;
    return new;
  end if;
  cid := coalesce((to_jsonb(new) ->> 'company_id')::uuid, (to_jsonb(old) ->> 'company_id')::uuid);
  if tg_op = 'INSERT' then
    perform log_activity(cid, tg_table_name || '.added', null, to_jsonb(new) - 'company_id' - 'id');
  elsif tg_op = 'DELETE' then
    perform log_activity(cid, tg_table_name || '.deleted', null, to_jsonb(old) - 'company_id' - 'id');
  else
    d := changed_fields(to_jsonb(old) - 'id', to_jsonb(new) - 'id',
      array(select jsonb_object_keys(to_jsonb(new) - 'id' - 'company_id' - 'created_at')));
    if d <> '{}'::jsonb then perform log_activity(cid, tg_table_name || '.updated', null, d || jsonb_build_object('name', to_jsonb(new) ->> 'name')); end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists audit_companies on public.companies;
create trigger audit_companies after update on public.companies for each row execute function public.audit_settings();
drop trigger if exists audit_shifts on public.shifts;
create trigger audit_shifts after insert or update or delete on public.shifts for each row execute function public.audit_settings();
drop trigger if exists audit_offices on public.offices;
create trigger audit_offices after insert or update or delete on public.offices for each row execute function public.audit_settings();
drop trigger if exists audit_holidays on public.holidays;
create trigger audit_holidays after insert or update or delete on public.holidays for each row execute function public.audit_settings();

------------------------------------------------------------------------------
-- Photo retention (used by the daily background job, which runs with the service key)
------------------------------------------------------------------------------

create or replace function public.expired_photos(p_limit int default 500)
returns table (attendance_id uuid, selfie_path text, group_photo_path text)
language sql stable security definer set search_path = public as $$
  select a.id, a.selfie_path, a.group_photo_path
  from attendance a join companies c on c.id = a.company_id
  where (a.selfie_path is not null or a.group_photo_path is not null)
    and a.clock_in_at < now() - make_interval(days => c.photo_retention_days)
  order by a.clock_in_at
  limit p_limit
$$;

create or replace function public.forget_photos(p_ids uuid[]) returns int
language sql security definer set search_path = public as $$
  with u as (update attendance set selfie_path = null, group_photo_path = null where id = any(p_ids) returning 1)
  select count(*)::int from u
$$;

------------------------------------------------------------------------------
-- Crew marking: admins who have two-step login set up must have entered their code.
------------------------------------------------------------------------------
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
  if me.role = 'admin' and not is_admin() then raise exception 'MFA_REQUIRED'; end if;
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


------------------------------------------------------------------------------
-- Permissions
------------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.expired_photos(int), public.forget_photos(uuid[]),
  public.log_activity(uuid, text, uuid, jsonb) from authenticated;
grant execute on function public.expired_photos(int), public.forget_photos(uuid[]) to service_role;
grant execute on function
  public.has_verified_mfa(), public.session_aal(), public.is_admin(), public.my_security_state(), public.can_view_person(uuid),
  public.join_company(text, text), public.my_pending_company(), public.pending_members(), public.approve_member(uuid),
  public.reject_member(uuid), public.cancel_join_request(),
  public.crew_mark(uuid[], text, double precision, double precision, double precision, text, text)
to authenticated;

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

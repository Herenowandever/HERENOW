-- HereNow: multi-company attendance with geofence, selfie and QR check-in.
-- Run this once in the Supabase SQL editor (or with `supabase db push`).

create extension if not exists pgcrypto with schema extensions;

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 2 and 120),
  timezone    text not null default 'Asia/Kolkata',
  join_code   text not null unique,
  created_at  timestamptz not null default now()
);

create table public.shifts (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies on delete cascade,
  name           text not null check (length(trim(name)) between 1 and 60),
  start_time     time not null,
  end_time       time not null,
  grace_minutes  int  not null default 10 check (grace_minutes between 0 and 180),
  created_at     timestamptz not null default now()
);
create index on public.shifts (company_id);

create table public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  company_id    uuid not null references public.companies on delete cascade,
  full_name     text not null check (length(trim(full_name)) between 1 and 120),
  job_title     text,
  role          text not null default 'employee' check (role in ('admin','employee')),
  shift_id      uuid references public.shifts on delete set null,
  active        boolean not null default true,
  consented_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index on public.profiles (company_id);

create table public.offices (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 120),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  radius_m    int not null default 150 check (radius_m between 25 and 5000),
  created_at  timestamptz not null default now()
);
create index on public.offices (company_id);

-- Kept apart from offices so employees can read office locations without the QR secret.
create table public.office_secrets (
  office_id  uuid primary key references public.offices on delete cascade,
  secret     text not null default encode(extensions.gen_random_bytes(24), 'hex')
);

create table public.attendance (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies on delete cascade,
  user_id         uuid not null references public.profiles on delete cascade,
  work_date       date not null,
  office_id       uuid references public.offices on delete set null,
  clock_in_at     timestamptz not null default now(),
  clock_out_at    timestamptz,
  in_method       text not null check (in_method in ('gps','qr')),
  out_method      text check (out_method in ('gps','qr')),
  in_lat double precision, in_lng double precision, in_accuracy_m double precision, in_distance_m double precision,
  out_lat double precision, out_lng double precision, out_accuracy_m double precision, out_distance_m double precision,
  selfie_path     text,
  shift_id        uuid references public.shifts on delete set null,
  shift_start     time,
  shift_end       time,
  is_late         boolean not null default false,
  edited_by       uuid references public.profiles on delete set null,
  created_at      timestamptz not null default now(),
  unique (user_id, work_date),
  check (clock_out_at is null or clock_out_at > clock_in_at)
);
create index on public.attendance (company_id, work_date);

------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------

create or replace function public.my_company_id() returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from profiles where id = auth.uid() and active
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid() and active), false)
$$;

create or replace function public.gen_code(n int) returns text
language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b bytea := extensions.gen_random_bytes(n);
  s text := '';
begin
  for i in 0..n-1 loop
    s := s || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return s;
end $$;

create or replace function public.distance_m(lat1 double precision, lng1 double precision,
                                              lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371008.8 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- Daily 6-character code for an office, derived from its secret. Changes every local day.
create or replace function public.qr_code_for(p_office uuid, p_date date) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  h bytea;
  s text := '';
begin
  select extensions.hmac(p_office::text || ':' || p_date::text, secret, 'sha256')
    into h from office_secrets where office_id = p_office;
  if h is null then return null; end if;
  for i in 0..5 loop
    s := s || substr(alphabet, (get_byte(h, i) % 32) + 1, 1);
  end loop;
  return s;
end $$;
revoke execute on function public.qr_code_for(uuid, date) from public, anon, authenticated;

create or replace function public.office_secret_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into office_secrets (office_id) values (new.id);
  return new;
end $$;
create trigger offices_secret after insert on public.offices
  for each row execute function public.office_secret_trg();

create or replace function public.company_today(p_company uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone timezone)::date from companies where id = p_company
$$;

------------------------------------------------------------------------------
-- Row-level security
------------------------------------------------------------------------------

alter table public.companies      enable row level security;
alter table public.shifts         enable row level security;
alter table public.profiles       enable row level security;
alter table public.offices        enable row level security;
alter table public.office_secrets enable row level security;  -- no policies: functions only
alter table public.attendance     enable row level security;

create policy "members read their company" on public.companies
  for select using (id = public.my_company_id());
create policy "admins rename company" on public.companies
  for update using (id = public.my_company_id() and public.is_admin())
  with check (id = public.my_company_id());

create policy "members read shifts" on public.shifts
  for select using (company_id = public.my_company_id());
create policy "admins manage shifts" on public.shifts
  for all using (company_id = public.my_company_id() and public.is_admin())
  with check (company_id = public.my_company_id() and public.is_admin());

create policy "members read offices" on public.offices
  for select using (company_id = public.my_company_id());
create policy "admins manage offices" on public.offices
  for all using (company_id = public.my_company_id() and public.is_admin())
  with check (company_id = public.my_company_id() and public.is_admin());

create policy "read own profile, admins read team" on public.profiles
  for select using (id = auth.uid() or (company_id = public.my_company_id() and public.is_admin()));

create policy "read own attendance, admins read team" on public.attendance
  for select using (user_id = auth.uid() or (company_id = public.my_company_id() and public.is_admin()));

-- Profiles and attendance are written only through the functions below.
revoke insert, update, delete on public.profiles, public.attendance, public.companies from anon, authenticated;
grant update (name, timezone) on public.companies to authenticated;

------------------------------------------------------------------------------
-- Onboarding
------------------------------------------------------------------------------

create or replace function public.create_company(p_company_name text, p_full_name text,
                                                 p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql security definer set search_path = public as $$
declare c uuid; s uuid;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN'; end if;
  if exists (select 1 from profiles where id = auth.uid()) then raise exception 'ALREADY_IN_COMPANY'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then raise exception 'BAD_TIMEZONE'; end if;
  insert into companies (name, timezone, join_code) values (trim(p_company_name), p_timezone, gen_code(8))
    returning id into c;
  insert into shifts (company_id, name, start_time, end_time) values (c, 'General', '09:30', '18:30')
    returning id into s;
  insert into profiles (id, company_id, full_name, role, shift_id) values (auth.uid(), c, trim(p_full_name), 'admin', s);
  return c;
end $$;

create or replace function public.join_company(p_join_code text, p_full_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare c uuid; s uuid;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN'; end if;
  if exists (select 1 from profiles where id = auth.uid()) then raise exception 'ALREADY_IN_COMPANY'; end if;
  select id into c from companies where join_code = upper(trim(p_join_code));
  if c is null then raise exception 'BAD_JOIN_CODE'; end if;
  select id into s from shifts where company_id = c order by created_at limit 1;
  insert into profiles (id, company_id, full_name, shift_id) values (auth.uid(), c, trim(p_full_name), s);
  return c;
end $$;

create or replace function public.regenerate_join_code() returns text
language plpgsql security definer set search_path = public as $$
declare code text := gen_code(8);
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  update companies set join_code = code where id = my_company_id();
  return code;
end $$;

create or replace function public.accept_privacy_notice() returns void
language sql security definer set search_path = public as $$
  update profiles set consented_at = now() where id = auth.uid() and consented_at is null
$$;

create or replace function public.update_member(p_member uuid, p_role text, p_shift uuid,
                                                p_job_title text, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if not exists (select 1 from profiles where id = p_member and company_id = my_company_id()) then
    raise exception 'NOT_FOUND'; end if;
  if p_shift is not null and not exists (select 1 from shifts where id = p_shift and company_id = my_company_id()) then
    raise exception 'NOT_FOUND'; end if;
  if p_member = auth.uid() and (p_role <> 'admin' or not p_active) then
    raise exception 'CANNOT_DEMOTE_SELF'; end if;
  update profiles set role = p_role, shift_id = p_shift, job_title = nullif(trim(p_job_title), ''), active = p_active
    where id = p_member;
end $$;

------------------------------------------------------------------------------
-- Clocking in and out
------------------------------------------------------------------------------

-- Checks that the person is at an office (by GPS or today's QR code). Returns the office id and distance.
create or replace function public.verify_presence(p_company uuid, p_date date, p_lat double precision,
  p_lng double precision, p_accuracy double precision, p_qr text,
  out office_id uuid, out distance double precision, out method text)
language plpgsql stable security definer set search_path = public as $$
declare o record; best double precision; best_o record;
begin
  if p_qr is not null and length(trim(p_qr)) > 0 then
    select ofc.id into office_id from offices ofc
      where ofc.company_id = p_company
        and qr_code_for(ofc.id, p_date) = upper(trim(regexp_replace(p_qr, '^HERENOW:[^:]*:', '', 'i')));
    if office_id is null then raise exception 'INVALID_QR'; end if;
    method := 'qr';
    return;
  end if;

  if p_lat is null or p_lng is null then raise exception 'NO_LOCATION'; end if;
  if p_accuracy is not null and p_accuracy > 100 then raise exception 'WEAK_GPS|%', round(p_accuracy); end if;
  for o in select * from offices where company_id = p_company loop
    if best is null or distance_m(p_lat, p_lng, o.lat, o.lng) - o.radius_m < best then
      best := distance_m(p_lat, p_lng, o.lat, o.lng) - o.radius_m;
      best_o := o;
    end if;
  end loop;
  if best_o is null then raise exception 'NO_OFFICE'; end if;
  distance := distance_m(p_lat, p_lng, best_o.lat, best_o.lng);
  -- Allow up to 30 m of the phone's reported uncertainty at the zone edge.
  if distance > best_o.radius_m + least(coalesce(p_accuracy, 0), 30) then
    raise exception 'OUTSIDE_ZONE|%|%|%', round(distance), best_o.radius_m, best_o.name;
  end if;
  office_id := best_o.id;
  method := 'gps';
end $$;
revoke execute on function public.verify_presence(uuid, date, double precision, double precision, double precision, text)
  from public, anon, authenticated;

create or replace function public.clock_in(p_lat double precision default null, p_lng double precision default null,
  p_accuracy double precision default null, p_qr text default null, p_selfie_path text default null)
returns public.attendance language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles; tz text; local_now timestamp; d date; v record; sh shifts; rec attendance;
  late_by double precision := 0;
begin
  select * into me from profiles where id = auth.uid() and active;
  if me.id is null then raise exception 'NOT_A_MEMBER'; end if;
  if me.consented_at is null then raise exception 'NEEDS_CONSENT'; end if;
  select timezone into tz from companies where id = me.company_id;
  local_now := now() at time zone tz;
  d := local_now::date;

  if exists (select 1 from attendance where user_id = me.id and clock_out_at is null
             and clock_in_at > now() - interval '20 hours') then
    raise exception 'ALREADY_IN'; end if;
  if exists (select 1 from attendance where user_id = me.id and work_date = d) then
    raise exception 'ALREADY_DONE'; end if;
  if p_selfie_path is null or p_selfie_path not like me.company_id::text || '/' || me.id::text || '/%' then
    raise exception 'NEEDS_SELFIE'; end if;

  select * into v from verify_presence(me.company_id, d, p_lat, p_lng, p_accuracy, p_qr);
  select * into sh from shifts where id = me.shift_id;
  -- Minutes after shift start, wrapped to -12h..+12h so night shifts work across midnight.
  if sh.id is not null then
    late_by := extract(epoch from (local_now::time - sh.start_time)) / 60;
    if late_by > 720 then late_by := late_by - 1440; elsif late_by < -720 then late_by := late_by + 1440; end if;
  end if;

  insert into attendance (company_id, user_id, work_date, office_id, in_method,
      in_lat, in_lng, in_accuracy_m, in_distance_m, selfie_path,
      shift_id, shift_start, shift_end, is_late)
  values (me.company_id, me.id, d, v.office_id, v.method,
      p_lat, p_lng, p_accuracy, v.distance, p_selfie_path,
      sh.id, sh.start_time, sh.end_time, late_by > coalesce(sh.grace_minutes, 0))
  returning * into rec;
  return rec;
end $$;

create or replace function public.clock_out(p_lat double precision default null, p_lng double precision default null,
  p_accuracy double precision default null, p_qr text default null)
returns public.attendance language plpgsql volatile security definer set search_path = public as $$
declare me profiles; tz text; rec attendance; v record;
begin
  select * into me from profiles where id = auth.uid() and active;
  if me.id is null then raise exception 'NOT_A_MEMBER'; end if;
  select timezone into tz from companies where id = me.company_id;
  select * into rec from attendance where user_id = me.id and clock_out_at is null
    and clock_in_at > now() - interval '20 hours' order by clock_in_at desc limit 1;
  if rec.id is null then raise exception 'NOT_IN'; end if;

  select * into v from verify_presence(me.company_id, (now() at time zone tz)::date, p_lat, p_lng, p_accuracy, p_qr);

  update attendance set clock_out_at = greatest(now(), clock_in_at + interval '1 second'), out_method = v.method,
      out_lat = p_lat, out_lng = p_lng, out_accuracy_m = p_accuracy, out_distance_m = v.distance
    where id = rec.id returning * into rec;
  return rec;
end $$;

-- Admins can correct a record, e.g. when someone forgot to clock out.
create or replace function public.admin_edit_attendance(p_id uuid, p_clock_in timestamptz, p_clock_out timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if p_clock_out is not null and p_clock_out <= p_clock_in then raise exception 'BAD_TIMES'; end if;
  update attendance set clock_in_at = p_clock_in, clock_out_at = p_clock_out, edited_by = auth.uid()
    where id = p_id and company_id = my_company_id();
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

-- Admin-only: today's code for the reception QR screen.
create or replace function public.office_qr_code(p_office uuid) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() or not exists (select 1 from offices where id = p_office and company_id = my_company_id()) then
    raise exception 'ADMIN_ONLY'; end if;
  return qr_code_for(p_office, company_today(my_company_id()));
end $$;

------------------------------------------------------------------------------
-- Reports
------------------------------------------------------------------------------

create or replace function public.monthly_report(p_month date)
returns table (user_id uuid, full_name text, job_title text, shift_name text, active boolean,
               days_present int, late_days int, qr_days int, missing_clock_outs int,
               hours_worked numeric, overtime_hours numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY'; end if;
  return query
  with a as (
    select at.*,
      extract(epoch from (at.clock_out_at - at.clock_in_at)) / 3600.0 as worked,
      case when at.shift_start is null then null
           else extract(epoch from (at.shift_end - at.shift_start)) / 3600.0
                + case when at.shift_end <= at.shift_start then 24 else 0 end end as shift_len
    from attendance at
    where at.company_id = my_company_id()
      and at.work_date >= date_trunc('month', p_month)::date
      and at.work_date <  (date_trunc('month', p_month) + interval '1 month')::date
  )
  select p.id, p.full_name, p.job_title, s.name, p.active,
    count(a.id)::int,
    count(a.id) filter (where a.is_late)::int,
    count(a.id) filter (where a.in_method = 'qr')::int,
    count(a.id) filter (where a.clock_out_at is null and a.work_date < company_today(p.company_id))::int,
    round(coalesce(sum(a.worked), 0)::numeric, 2),
    round(coalesce(sum(greatest(a.worked - a.shift_len, 0)), 0)::numeric, 2)
  from profiles p
  left join shifts s on s.id = p.shift_id
  left join a on a.user_id = p.id
  where p.company_id = my_company_id()
  group by p.id, p.full_name, p.job_title, s.name, p.active
  having p.active or count(a.id) > 0
  order by p.full_name;
end $$;

------------------------------------------------------------------------------
-- Function permissions
------------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.my_company_id(), public.is_admin(), public.company_today(uuid),
  public.create_company(text, text, text), public.join_company(text, text), public.regenerate_join_code(),
  public.accept_privacy_notice(), public.update_member(uuid, text, uuid, text, boolean),
  public.clock_in(double precision, double precision, double precision, text, text),
  public.clock_out(double precision, double precision, double precision, text),
  public.admin_edit_attendance(uuid, timestamptz, timestamptz),
  public.office_qr_code(uuid), public.monthly_report(date)
to authenticated;

------------------------------------------------------------------------------
-- Live updates for the admin dashboard
------------------------------------------------------------------------------

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.attendance;
  end if;
end $$;

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

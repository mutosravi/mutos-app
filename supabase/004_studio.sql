-- Muto's app · clients (itinerary by secret link) and attendance & salary
-- Run after schema.sql, 002_crew_actions.sql and 003_gear_desk.sql: Supabase → SQL Editor → paste → Run.

create extension if not exists pgcrypto with schema extensions;

-- ── login types ────────────────────────────────────────────────────────
-- staff: office employee who is not on the crew list · accountant: prepares salaries · kiosk: the office screen that shows the check-in code
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check check (role in ('owner', 'manager', 'crew', 'gear', 'staff', 'accountant', 'kiosk'));

create or replace function public.is_payroll() returns boolean
  language sql stable as $$ select coalesce(public.my_role() in ('owner', 'accountant'), false) $$;

-- the accountant needs shoot days (crew pages) for salaries
drop policy if exists feed_select_acc on public.crew_feed;
create policy feed_select_acc on public.crew_feed for select to authenticated using (public.my_role() = 'accountant');

-- ══ CLIENTS ═════════════════════════════════════════════════════════════
-- one secret link per wedding; the client opens it (no login) and fills the details of each function
create table if not exists public.client_links (
  token       uuid primary key default gen_random_uuid(),
  wedding_key text not null unique,
  title       text not null check (length(title) <= 120),
  phone       text check (length(phone) <= 30),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
-- what the client sees: their functions as on the board (kept up to date by the owner's board)
create table if not exists public.client_feed (
  wedding_key text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
-- what the client filled in
create table if not exists public.client_itinerary (
  wedding_key  text primary key,
  data         jsonb not null default '{}'::jsonb,
  submitted_at timestamptz,
  updated_at   timestamptz not null default now(),
  reviewed_at  timestamptz
);
drop trigger if exists cfeed_touch on public.client_feed;
create trigger cfeed_touch before update on public.client_feed for each row execute function public.touch_updated_at();

alter table public.client_links enable row level security;
alter table public.client_feed enable row level security;
alter table public.client_itinerary enable row level security;
drop policy if exists clinks_all on public.client_links;
create policy clinks_all on public.client_links for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists cfeed_all on public.client_feed;
create policy cfeed_all on public.client_feed for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists citin_select on public.client_itinerary;
create policy citin_select on public.client_itinerary for select to authenticated using (public.is_staff());
drop policy if exists citin_update on public.client_itinerary;
create policy citin_update on public.client_itinerary for update to authenticated using (public.is_staff()) with check (public.is_staff());
revoke all on public.client_links, public.client_feed, public.client_itinerary from anon;
grant select, insert, update, delete on public.client_links, public.client_feed to authenticated;
grant select, update on public.client_itinerary to authenticated;

-- the client page talks only through these two functions, and only with a valid, active link
create or replace function public.client_get(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; f jsonb; i public.client_itinerary;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This link is not active. Please ask the studio for a new one.'); end if;
  select data into f from public.client_feed where wedding_key = l.wedding_key;
  select * into i from public.client_itinerary where wedding_key = l.wedding_key;
  return jsonb_build_object('title', l.title, 'functions', coalesce(f -> 'functions', '[]'::jsonb), 'answers', coalesce(i.data, '{}'::jsonb), 'submitted_at', i.submitted_at);
end $$;

create or replace function public.client_save(p_token uuid, p_data jsonb, p_submit boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare l public.client_links;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This link is not active. Please ask the studio for a new one.'); end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 60000 then return jsonb_build_object('error', 'Too much text. Please shorten the notes.'); end if;
  insert into public.client_itinerary as c (wedding_key, data, submitted_at, updated_at)
  values (l.wedding_key, p_data, case when p_submit then now() end, now())
  on conflict (wedding_key) do update set data = excluded.data, updated_at = now(),
    submitted_at = case when p_submit then now() else c.submitted_at end;
  return jsonb_build_object('ok', true, 'saved_at', now());
end $$;
revoke all on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean) from public;
grant execute on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean) to anon, authenticated;

-- ══ ATTENDANCE & SALARY ═════════════════════════════════════════════════
create table if not exists public.employees (
  email          text primary key check (email = lower(email)),
  name           text not null check (length(name) <= 80),
  person_key     text,                                   -- same person on the crew list (for shoot days)
  monthly_salary numeric not null default 0 check (monthly_salary >= 0),
  start_time     time not null default '10:00',
  weekly_off     smallint not null default 0 check (weekly_off between 0 and 6),   -- 0 = Sunday … 6 = Saturday
  paid_leave     numeric not null default 0 check (paid_leave between 0 and 10), -- paid leave days per month (0 = none)
  shoot_type     text not null default 'B' check (shoot_type in ('A', 'B')),     -- A: shoot day = paid office day · B: unpaid office day
  active         boolean not null default true,
  joined         date,
  bank           text check (length(bank) <= 200),
  updated_at     timestamptz not null default now()
);
drop trigger if exists emp_touch on public.employees;
create trigger emp_touch before update on public.employees for each row execute function public.touch_updated_at();

-- office location, code check on/off, late-night rule (one row)
create table if not exists public.att_settings (
  id             int primary key default 1 check (id = 1),
  office_lat     double precision,
  office_lng     double precision,
  radius_m       int not null default 150 check (radius_m between 30 and 2000),
  code_on        boolean not null default true,
  late_night_min int not null default 120 check (late_night_min between 0 and 600),  -- Type A: later start after an evening shoot
  updated_at     timestamptz not null default now()
);
insert into public.att_settings (id) values (1) on conflict do nothing;
-- every change to these settings is written down (who switched the office code off, and when)
create table if not exists public.att_log (id bigint generated always as identity primary key, at timestamptz not null default now(), by_email text, what text not null);
create or replace function public.att_settings_log() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.code_on is distinct from old.code_on then insert into public.att_log (by_email, what) values (public.my_email(), 'Office code check turned ' || case when new.code_on then 'ON' else 'OFF' end); end if;
  if new.office_lat is distinct from old.office_lat or new.office_lng is distinct from old.office_lng or new.radius_m is distinct from old.radius_m then insert into public.att_log (by_email, what) values (public.my_email(), 'Office location set (' || round(new.office_lat::numeric, 5) || ', ' || round(new.office_lng::numeric, 5) || ', ' || new.radius_m || ' m)'); end if;
  if new.late_night_min is distinct from old.late_night_min then insert into public.att_log (by_email, what) values (public.my_email(), 'Late start after evening shoot: ' || new.late_night_min || ' min'); end if;
  new.updated_at := now(); return new;
end $$;
drop trigger if exists att_settings_log on public.att_settings;
create trigger att_settings_log before update on public.att_settings for each row execute function public.att_settings_log();

-- the secret behind the office code: nobody can read it, only the functions below use it
create table if not exists public.att_secret (id int primary key default 1 check (id = 1), secret text not null);
insert into public.att_secret (id, secret) values (1, encode(extensions.gen_random_bytes(32), 'hex')) on conflict do nothing;

create table if not exists public.att_punch (
  id       bigint generated always as identity primary key,
  email    text not null,
  day      date not null,
  kind     text not null check (kind in ('in', 'lunch_out', 'lunch_in', 'out')),
  at       timestamptz not null default now(),
  lat      double precision, lng double precision, acc double precision, dist_m int,
  via_code boolean not null default false,
  flag     text,                       -- 'holiday_unasked' …
  by_fix   boolean not null default false
);
create index if not exists att_punch_day on public.att_punch (day, email);

create table if not exists public.att_requests (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  kind       text not null check (kind in ('leave', 'fix', 'advance')),
  day        date,                      -- leave from / fix day
  day_to     date,                      -- leave to
  half       boolean not null default false,
  fix_kind   text check (fix_kind in ('in', 'lunch_out', 'lunch_in', 'out')),
  fix_time   time,
  amount     numeric check (amount >= 0),
  per_month  numeric check (per_month >= 0),
  recovered  numeric not null default 0,
  reason     text not null default '' check (length(reason) <= 300),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  note       text check (length(note) <= 300),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.holidays (
  id       uuid primary key default gen_random_uuid(),
  day      date not null,
  name     text not null check (length(name) <= 80),
  half     boolean not null default false,
  only_for text[],        -- null = everyone, else these employee emails
  ask_in   text[] not null default '{}'   -- asked to come in: paid holiday + a day's pay for working
);

create table if not exists public.payroll_runs (
  month     text primary key check (month ~ '^\d{4}-\d{2}$'),
  status    text not null default 'draft' check (status in ('draft', 'locked')),
  data      jsonb not null default '{}'::jsonb,
  locked_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.payslips (
  month text not null, email text not null, data jsonb not null,
  primary key (month, email)
);

create or replace function public.month_locked(d date) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.payroll_runs where month = to_char(d, 'YYYY-MM') and status = 'locked') $$;

-- requests: employees ask, only the owner decides; advances up to one month's salary
create or replace function public.att_request_rules() returns trigger language plpgsql security definer set search_path = public as $$
declare e public.employees; open_adv numeric;
begin
  if tg_op = 'INSERT' and not public.is_owner() then
    new.email := public.my_email(); new.status := 'pending'; new.decided_at := null; new.note := null; new.recovered := 0;
    select * into e from public.employees where email = new.email and active;
    if not found then raise exception 'You are not on the employee list.'; end if;
    if new.kind = 'advance' then
      if coalesce(new.amount, 0) <= 0 then raise exception 'Enter the amount.'; end if;
      select coalesce(sum(amount - recovered), 0) into open_adv from public.att_requests where email = new.email and kind = 'advance' and status in ('pending', 'approved');
      if open_adv + new.amount > e.monthly_salary then raise exception 'Advances can be up to one month''s salary (₹%). Available now: ₹%.', e.monthly_salary, greatest(e.monthly_salary - open_adv, 0); end if;
    end if;
    if new.kind in ('leave', 'fix') and new.day is null then raise exception 'Pick the date.'; end if;
    if new.kind in ('leave', 'fix') and public.month_locked(new.day) then raise exception 'That month''s salary is already locked.'; end if;
  end if;
  if tg_op = 'UPDATE' then
    if not public.is_owner() then raise exception 'Only the admin can decide requests.'; end if;
    if new.status <> old.status then new.decided_at := now(); end if;
    -- an approved correction becomes a check-in entry
    if new.kind = 'fix' and new.status = 'approved' and old.status <> 'approved' then
      insert into public.att_punch (email, day, kind, at, by_fix)
      values (new.email, new.day, new.fix_kind, ((new.day + new.fix_time)::timestamp at time zone 'Asia/Kolkata'), true);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists att_request_rules on public.att_requests;
create trigger att_request_rules before insert or update on public.att_requests for each row execute function public.att_request_rules();

create or replace function public.holiday_rules() returns trigger language plpgsql as $$
begin
  if public.month_locked(coalesce(new.day, old.day)) or (tg_op = 'UPDATE' and public.month_locked(old.day)) then raise exception 'That month''s salary is already locked.'; end if;
  return coalesce(new, old);
end $$;
drop trigger if exists holiday_rules on public.holidays;
create trigger holiday_rules before insert or update or delete on public.holidays for each row execute function public.holiday_rules();

-- the accountant prepares; only the owner locks; a locked month never changes
create or replace function public.payroll_rules() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status = 'locked' then raise exception 'This month is locked.'; end if;
  if tg_op = 'DELETE' then if old.status = 'locked' then raise exception 'This month is locked.'; end if; return old; end if;
  if new.status = 'locked' and not public.is_owner() then raise exception 'Only the admin can lock a month.'; end if;
  if new.status = 'locked' then new.locked_at := now(); end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists payroll_rules on public.payroll_runs;
create trigger payroll_rules before insert or update or delete on public.payroll_runs for each row execute function public.payroll_rules();

-- the office code: 6 digits, new every 30 seconds
create or replace function public.att_code_at(slot bigint) returns text
  language sql stable security definer set search_path = public as $$
  select lpad(((('x' || substr(encode(extensions.hmac(slot::text, (select secret from public.att_secret where id = 1), 'sha256'), 'hex'), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0') $$;
revoke all on function public.att_code_at(bigint) from public, anon, authenticated;

create or replace function public.att_office_code() returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare s bigint := floor(extract(epoch from now()) / 30);
begin
  if coalesce(public.my_role(), '') not in ('owner', 'kiosk') then raise exception 'Only the office screen can show the code.'; end if;
  return jsonb_build_object('code', public.att_code_at(s), 'seconds_left', 30 - (floor(extract(epoch from now()))::bigint % 30));
end $$;

-- check in / lunch / check out: location and code are checked here, on the server
create or replace function public.att_punch(p_kind text, p_lat double precision, p_lng double precision, p_acc double precision, p_code text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare e public.employees; st public.att_settings; d date := public.today_ist(); last text; dist double precision; s bigint := floor(extract(epoch from now()) / 30); h public.holidays; flag text; ok_code boolean := false;
begin
  select * into e from public.employees where email = public.my_email() and active;
  if not found then return jsonb_build_object('error', 'You are not on the employee list. Ask Ravi.'); end if;
  select * into st from public.att_settings where id = 1;
  if st.office_lat is null then return jsonb_build_object('error', 'The office location is not set yet. Ask Ravi.'); end if;
  if p_lat is null or p_lng is null then return jsonb_build_object('error', 'Turn on location for this app and try again.'); end if;
  dist := 2 * 6371000 * asin(sqrt(power(sin(radians(p_lat - st.office_lat) / 2), 2) + cos(radians(st.office_lat)) * cos(radians(p_lat)) * power(sin(radians(p_lng - st.office_lng) / 2), 2)));
  if dist - least(coalesce(p_acc, 0), 50) > st.radius_m then return jsonb_build_object('error', 'You are not at the office (' || round(dist) || ' m away). Check in from the office.', 'dist', round(dist)); end if;
  if st.code_on then
    ok_code := p_code is not null and (p_code = public.att_code_at(s) or p_code = public.att_code_at(s - 1));
    if not ok_code then return jsonb_build_object('error', 'Wrong or old office code. Type the code shown on the office screen now.'); end if;
  end if;
  select kind into last from public.att_punch where email = e.email and day = d order by at desc, id desc limit 1;
  last := coalesce(last, '');
  if not ((last = '' and p_kind = 'in') or (last = 'in' and p_kind in ('lunch_out', 'out')) or (last = 'lunch_out' and p_kind = 'lunch_in') or (last = 'lunch_in' and p_kind = 'out')) then
    return jsonb_build_object('error', case when last = 'out' then 'You have already checked out today.' else 'That step is not next. Reload the app.' end);
  end if;
  select * into h from public.holidays where day = d and (only_for is null or e.email = any(only_for)) limit 1;
  if found and not (e.email = any(h.ask_in)) then flag := 'holiday_unasked'; end if;
  insert into public.att_punch (email, day, kind, lat, lng, acc, dist_m, via_code, flag)
  values (e.email, d, p_kind, p_lat, p_lng, p_acc, round(dist), ok_code, flag);
  return jsonb_build_object('ok', true, 'kind', p_kind, 'at', now(), 'dist', round(dist), 'flag', flag);
end $$;
revoke all on function public.att_punch(text, double precision, double precision, double precision, text) from public, anon;
grant execute on function public.att_punch(text, double precision, double precision, double precision, text), public.att_office_code() to authenticated;

-- ── privacy rules ──────────────────────────────────────────────────────
alter table public.employees enable row level security;
alter table public.att_settings enable row level security;
alter table public.att_secret enable row level security;
alter table public.att_punch enable row level security;
alter table public.att_requests enable row level security;
alter table public.holidays enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payslips enable row level security;
alter table public.att_log enable row level security;
drop policy if exists alog_select on public.att_log;
create policy alog_select on public.att_log for select to authenticated using (public.is_payroll());

drop policy if exists emp_select on public.employees;
create policy emp_select on public.employees for select to authenticated using (email = public.my_email() or public.is_payroll());
drop policy if exists emp_write on public.employees;
create policy emp_write on public.employees for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists atts_select on public.att_settings;
create policy atts_select on public.att_settings for select to authenticated using (true);
drop policy if exists atts_update on public.att_settings;
create policy atts_update on public.att_settings for update to authenticated using (public.is_owner()) with check (public.is_owner());

-- check-ins: read your own (owner and accountant read all); written only by att_punch() or by the owner
drop policy if exists punch_select on public.att_punch;
create policy punch_select on public.att_punch for select to authenticated using (email = public.my_email() or public.is_payroll());
drop policy if exists punch_owner on public.att_punch;
create policy punch_owner on public.att_punch for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists req_select on public.att_requests;
create policy req_select on public.att_requests for select to authenticated using (email = public.my_email() or public.is_payroll());
drop policy if exists req_insert on public.att_requests;
create policy req_insert on public.att_requests for insert to authenticated with check (true);   -- the trigger fixes the email and status
drop policy if exists req_update on public.att_requests;
create policy req_update on public.att_requests for update to authenticated using (public.is_owner()) with check (public.is_owner());
drop policy if exists req_delete on public.att_requests;
create policy req_delete on public.att_requests for delete to authenticated using ((email = public.my_email() and status = 'pending') or public.is_owner());

drop policy if exists hol_select on public.holidays;
create policy hol_select on public.holidays for select to authenticated using (true);
drop policy if exists hol_write on public.holidays;
create policy hol_write on public.holidays for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists pay_all on public.payroll_runs;
create policy pay_all on public.payroll_runs for all to authenticated using (public.is_payroll()) with check (public.is_payroll());
drop policy if exists slip_select on public.payslips;
create policy slip_select on public.payslips for select to authenticated using (email = public.my_email() or public.is_payroll());
drop policy if exists slip_write on public.payslips;
create policy slip_write on public.payslips for all to authenticated using (public.is_owner()) with check (public.is_owner());

revoke all on public.att_log, public.employees, public.att_settings, public.att_secret, public.att_punch, public.att_requests, public.holidays, public.payroll_runs, public.payslips from anon, authenticated;
grant select, insert, update, delete on public.employees, public.att_punch, public.att_requests, public.holidays, public.payroll_runs, public.payslips to authenticated;
grant select, update on public.att_settings to authenticated;
grant select on public.att_log to authenticated;
-- att_secret: no grants at all

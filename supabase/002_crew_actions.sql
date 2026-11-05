-- Muto's Studio team app · step 2: what crew can do from their own page
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run. (Safe to run again.)
-- Adds: "not available" dates, shoot confirmations, data handover, gear pickup/return, reminder sign-ups.

-- today in India (the database clock runs in UTC)
create or replace function public.today_ist() returns date
  language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

-- ── not available dates ────────────────────────────────────────────────
-- status: 'auto' = accepted straight away; 'pending' = needs Ravi (booked that day, or within 7 days);
-- 'approved' / 'declined' = Ravi decided. why: 'booked' or 'soon' for pending ones.
create table if not exists public.crew_away (
  id          uuid primary key default gen_random_uuid(),
  person_key  text not null,
  date        date not null,
  slot        text not null default 'Full day' check (slot in ('Full day', 'Morning', 'Evening')),
  reason      text not null default '' check (length(reason) <= 200),
  status      text not null default 'pending' check (status in ('auto', 'pending', 'approved', 'declined')),
  why         text not null default '',
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  unique (person_key, date, slot)
);

-- does this person have a shoot on that date? (reads their crew page, which the board keeps up to date)
create or replace function public.is_booked(pkey text, d date) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.crew_feed f, jsonb_array_elements(coalesce(f.data -> 'shoots', '[]'::jsonb)) s
                 where f.person_key = pkey and s ->> 'date' = to_char(d, 'YYYY-MM-DD')) $$;

-- crew cannot choose the status: the database decides it, so the 7-day and booked-day rules always hold
create or replace function public.crew_away_rules() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_staff() then
      new.person_key := public.my_person_key();
      if new.date < public.today_ist() then raise exception 'That date has passed.'; end if;
      if new.date > public.today_ist() + 400 then raise exception 'Pick a date within the next year.'; end if;
      new.why := case when public.is_booked(new.person_key, new.date) then 'booked'
                      when new.date < public.today_ist() + 7 then 'soon' else '' end;
      new.status := case when new.why = '' then 'auto' else 'pending' end;
      new.decided_at := null;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status and new.status in ('approved', 'declined') then new.decided_at := now(); end if;
  end if;
  return new;
end $$;
drop trigger if exists crew_away_rules on public.crew_away;
create trigger crew_away_rules before insert or update on public.crew_away for each row execute function public.crew_away_rules();

-- ── per shoot: confirmation, data handover, gear ───────────────────────
create table if not exists public.crew_status (
  person_key    text not null,
  event_id      text not null,
  shoot_date    date,
  confirm       text check (confirm in ('yes', 'no')),
  confirm_sig   text,          -- what the shoot looked like when they answered; a change asks them again
  confirm_note  text check (length(confirm_note) <= 300),
  confirmed_at  timestamptz,
  data_at       timestamptz,   -- cards / footage handed over
  data_note     text check (length(data_note) <= 300),
  gear_out_at   timestamptz,   -- picked up studio gear
  gear_back_at  timestamptz,   -- returned it
  updated_at    timestamptz not null default now(),
  primary key (person_key, event_id)
);
drop trigger if exists status_touch on public.crew_status;
create trigger status_touch before update on public.crew_status for each row execute function public.touch_updated_at();

-- crew can only answer for shoots on their own page (upcoming or the last 30 days)
create or replace function public.in_my_feed(pkey text, ev text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.crew_feed f, jsonb_array_elements(coalesce(f.data -> 'shoots', '[]'::jsonb)) s
                 where f.person_key = pkey and s ->> 'id' = ev) $$;

-- ── reminder sign-ups (phone notifications) ────────────────────────────
create table if not exists public.push_subs (
  endpoint    text primary key,
  person_key  text not null,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now(),
  last_ok     timestamptz,
  fails       int not null default 0
);

-- ── privacy rules ──────────────────────────────────────────────────────
alter table public.crew_away   enable row level security;
alter table public.crew_status enable row level security;
alter table public.push_subs   enable row level security;

drop policy if exists away_select on public.crew_away;
create policy away_select on public.crew_away for select to authenticated
  using (public.is_staff() or person_key = public.my_person_key());
drop policy if exists away_insert on public.crew_away;
create policy away_insert on public.crew_away for insert to authenticated
  with check (public.is_staff() or (public.my_role() = 'crew' and person_key = public.my_person_key()));
drop policy if exists away_update on public.crew_away;
create policy away_update on public.crew_away for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
-- crew can take back their own future dates
drop policy if exists away_delete on public.crew_away;
create policy away_delete on public.crew_away for delete to authenticated
  using (public.is_staff() or (person_key = public.my_person_key() and date >= public.today_ist()));

drop policy if exists status_select on public.crew_status;
create policy status_select on public.crew_status for select to authenticated
  using (public.is_staff() or person_key = public.my_person_key());
drop policy if exists status_insert on public.crew_status;
create policy status_insert on public.crew_status for insert to authenticated
  with check (public.is_staff() or (person_key = public.my_person_key() and public.in_my_feed(person_key, event_id)));
drop policy if exists status_update on public.crew_status;
create policy status_update on public.crew_status for update to authenticated
  using (public.is_staff() or person_key = public.my_person_key())
  with check (public.is_staff() or (person_key = public.my_person_key() and public.in_my_feed(person_key, event_id)));
drop policy if exists status_delete on public.crew_status;
create policy status_delete on public.crew_status for delete to authenticated using (public.is_staff());

drop policy if exists push_select on public.push_subs;
create policy push_select on public.push_subs for select to authenticated using (person_key = public.my_person_key());
drop policy if exists push_insert on public.push_subs;
create policy push_insert on public.push_subs for insert to authenticated
  with check (person_key is not null and person_key = public.my_person_key());
drop policy if exists push_update on public.push_subs;
create policy push_update on public.push_subs for update to authenticated
  using (person_key = public.my_person_key()) with check (person_key = public.my_person_key());
drop policy if exists push_delete on public.push_subs;
create policy push_delete on public.push_subs for delete to authenticated using (person_key = public.my_person_key());

revoke all on public.crew_away, public.crew_status, public.push_subs from anon;
grant select, insert, update, delete on public.crew_away, public.crew_status, public.push_subs to authenticated;

-- ── live updates for the board ─────────────────────────────────────────
do $$ declare t text; begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['crew_away', 'crew_status'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

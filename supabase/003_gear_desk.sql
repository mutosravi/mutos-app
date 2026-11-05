-- Muto's Studio team app · step 3: the Gear desk
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run. (Safe to run again.)
-- Adds a "gear" login (a gear manager who sees only the Gear desk), the gear schedule the board shares with the desk,
-- and the in/out log: who took or returned which item, when, in what condition.

-- ── a new kind of login: gear manager ──────────────────────────────────
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check check (role in ('owner', 'manager', 'crew', 'gear'));

create or replace function public.is_gear_desk() returns boolean
  language sql stable as $$ select coalesce(public.my_role() in ('owner', 'manager', 'gear'), false) $$;

-- ── what the desk needs from the board: items, and who carries what on which shoot (no client details) ──
create table if not exists public.gear_feed (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
drop trigger if exists gear_feed_touch on public.gear_feed;
create trigger gear_feed_touch before update on public.gear_feed for each row execute function public.touch_updated_at();

-- ── the in / out log ───────────────────────────────────────────────────
create table if not exists public.gear_log (
  id           uuid primary key default gen_random_uuid(),
  gear_id      text not null,
  gear_name    text not null,
  action       text not null check (action in ('out', 'in')),
  qty          int not null default 1 check (qty between 1 and 50),
  person_key   text not null,         -- who took it / who returned it
  person_name  text not null,
  event_id     text,                  -- the shoot it went out for (if any)
  shoot_date   date,
  condition    text not null default 'good' check (condition in ('good', 'minor', 'damaged', 'missing')),
  note         text check (length(note) <= 500),
  at           timestamptz not null default now(),
  by_email     text not null default public.my_email(),   -- who made the entry
  created_at   timestamptz not null default now()
);
create index if not exists gear_log_gear on public.gear_log (gear_id, at);
create index if not exists gear_log_person on public.gear_log (person_key, at);

-- the entry is always signed by whoever made it
create or replace function public.gear_log_sign() returns trigger language plpgsql as $$
begin new.by_email := public.my_email(); new.created_at := now(); return new; end $$;
drop trigger if exists gear_log_sign on public.gear_log;
create trigger gear_log_sign before insert on public.gear_log for each row execute function public.gear_log_sign();

-- ── privacy rules ──────────────────────────────────────────────────────
alter table public.gear_feed enable row level security;
alter table public.gear_log  enable row level security;

drop policy if exists gfeed_select on public.gear_feed;
create policy gfeed_select on public.gear_feed for select to authenticated using (public.is_gear_desk());
drop policy if exists gfeed_insert on public.gear_feed;
create policy gfeed_insert on public.gear_feed for insert to authenticated with check (public.is_staff());
drop policy if exists gfeed_update on public.gear_feed;
create policy gfeed_update on public.gear_feed for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- desk sees everything; a crew member sees only entries about themselves
drop policy if exists glog_select on public.gear_log;
create policy glog_select on public.gear_log for select to authenticated
  using (public.is_gear_desk() or (person_key is not null and person_key = public.my_person_key()));
drop policy if exists glog_insert on public.gear_log;
create policy glog_insert on public.gear_log for insert to authenticated with check (public.is_gear_desk());
-- entries are a record: no editing; a wrong entry can be removed by the owner, or by its maker within an hour
drop policy if exists glog_delete on public.gear_log;
create policy glog_delete on public.gear_log for delete to authenticated
  using (public.is_owner() or (public.is_gear_desk() and by_email = public.my_email() and created_at > now() - interval '1 hour'));

revoke all on public.gear_feed, public.gear_log from anon;
grant select, insert, update on public.gear_feed to authenticated;
grant select, insert, delete on public.gear_log to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'gear_log') then
    alter publication supabase_realtime add table public.gear_log;
  end if;
end $$;

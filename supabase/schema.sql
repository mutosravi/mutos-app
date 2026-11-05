-- Muto's Studio team app · database, logins and privacy rules
-- Run once in Supabase: Dashboard → SQL Editor → paste all of this → Run.
-- Before running, put YOUR Gmail (the one you will log in with) in the last statement.

-- ── tables ─────────────────────────────────────────────────────────────
-- Who may log in, and as what. person_key links a crew login to their name on the board.
create table if not exists public.members (
  email        text primary key check (email = lower(email)),
  role         text not null check (role in ('owner', 'manager', 'crew')),
  person_key   text,
  display_name text,
  updated_at   timestamptz not null default now()
);

-- Everything the board stores (shoots, crew, gear, away dates, settings, history), one row per record.
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

-- What each crew member is allowed to see: their own upcoming shoots, prepared by the board.
create table if not exists public.crew_feed (
  person_key text primary key,
  name       text,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.touch_updated_at();
drop trigger if exists feed_touch on public.crew_feed;
create trigger feed_touch before update on public.crew_feed for each row execute function public.touch_updated_at();
drop trigger if exists members_touch on public.members;
create trigger members_touch before update on public.members for each row execute function public.touch_updated_at();

-- ── who is asking ──────────────────────────────────────────────────────
create or replace function public.my_email() returns text
  language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.my_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.members where email = public.my_email() $$;

create or replace function public.my_person_key() returns text
  language sql stable security definer set search_path = public as $$
  select person_key from public.members where email = public.my_email() $$;

create or replace function public.is_owner() returns boolean
  language sql stable as $$ select coalesce(public.my_role() = 'owner', false) $$;

create or replace function public.is_staff() returns boolean
  language sql stable as $$ select coalesce(public.my_role() in ('owner', 'manager'), false) $$;

-- ── privacy rules ──────────────────────────────────────────────────────
alter table public.members   enable row level security;
alter table public.docs      enable row level security;
alter table public.crew_feed enable row level security;

-- Board data: owner and managers only. Payouts (collection 'seasons') are owner only.
drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated
  using (public.is_staff() and (collection <> 'seasons' or public.is_owner()));
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (public.is_staff() and (collection <> 'seasons' or public.is_owner()));
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (public.is_staff() and (collection <> 'seasons' or public.is_owner()))
  with check (public.is_staff() and (collection <> 'seasons' or public.is_owner()));
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated
  using (public.is_staff() and (collection <> 'seasons' or public.is_owner()));

-- Logins: everyone sees their own row; the owner manages crew and manager rows (never another owner row).
drop policy if exists members_select on public.members;
create policy members_select on public.members for select to authenticated
  using (email = public.my_email() or public.is_owner());
drop policy if exists members_insert on public.members;
create policy members_insert on public.members for insert to authenticated
  with check (public.is_owner() and role <> 'owner');
drop policy if exists members_update on public.members;
create policy members_update on public.members for update to authenticated
  using (public.is_owner() and role <> 'owner') with check (public.is_owner() and role <> 'owner');
drop policy if exists members_delete on public.members;
create policy members_delete on public.members for delete to authenticated
  using (public.is_owner() and role <> 'owner');

-- Crew feed: staff keep it up to date; a crew login reads only its own.
drop policy if exists feed_select on public.crew_feed;
create policy feed_select on public.crew_feed for select to authenticated
  using (public.is_staff() or (person_key is not null and person_key = public.my_person_key()));
drop policy if exists feed_insert on public.crew_feed;
create policy feed_insert on public.crew_feed for insert to authenticated with check (public.is_staff());
drop policy if exists feed_update on public.crew_feed;
create policy feed_update on public.crew_feed for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists feed_delete on public.crew_feed;
create policy feed_delete on public.crew_feed for delete to authenticated using (public.is_staff());

-- Nobody who is not logged in can touch anything.
revoke all on public.members, public.docs, public.crew_feed from anon;
grant select, insert, update, delete on public.members, public.docs, public.crew_feed to authenticated;

-- ── live updates for the board ─────────────────────────────────────────
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;

-- ── you, the owner ─────────────────────────────────────────────────────
-- Replace with the Gmail you will log in with (lower case).
insert into public.members (email, role, display_name)
values ('your.gmail@gmail.com', 'owner', 'Owner')
on conflict (email) do update set role = 'owner';

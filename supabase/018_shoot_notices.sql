-- Muto's app · "New shoot for you" on the shooter's phone (11 Nov 2026, Ravi: "Shooter needs to get notified whenever a new shoot
-- is assigned to them"). Run once, after 017_client_auto_apply.sql.
--
-- The board keeps every crew member's shoot list in crew_feed. When a shoot (today or later) appears in someone's list that was not
-- there before, this trigger queues a notice. The board then asks the server (/api/notify-shoots) to send the queued notices at once;
-- anything left over goes with the evening run. One message per person: "New shoot: Sharma Haldi" or "3 new shoots".
-- Changing a shoot's date or venue is not a "new shoot"; a shooter removed and later put back is told again.

create table if not exists public.shoot_notices (
  id         bigserial primary key,
  person_key text not null,
  event_id   text not null,
  shoot      text,
  date       date,
  slot       text,
  report     text,
  venue      text,
  role       text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  result     text
);
create index if not exists shoot_notices_unsent on public.shoot_notices (created_at) where sent_at is null;
alter table public.shoot_notices enable row level security;
revoke all on public.shoot_notices from anon, authenticated;   -- only the server reads and sends them

create or replace function public.crew_feed_notice_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare s jsonb; old_ids text[] := '{}';
begin
  if tg_op = 'UPDATE' and jsonb_typeof(old.data -> 'shoots') = 'array' then
    select coalesce(array_agg(x ->> 'id'), '{}') into old_ids from jsonb_array_elements(old.data -> 'shoots') x;
  end if;
  if jsonb_typeof(new.data -> 'shoots') <> 'array' then return null; end if;
  for s in select * from jsonb_array_elements(new.data -> 'shoots') loop
    if coalesce(s ->> 'id', '') = '' or (s ->> 'id') = any(old_ids) then continue; end if;
    if coalesce(s ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' or (s ->> 'date')::date < public.today_ist() then continue; end if;   -- only today or later
    insert into public.shoot_notices (person_key, event_id, shoot, date, slot, report, venue, role)
      values (new.person_key, s ->> 'id', left(s ->> 'shoot', 160), (s ->> 'date')::date, left(s ->> 'slot', 30), left(s ->> 'report', 30), left(s ->> 'venue', 200), left(s ->> 'role', 80));
  end loop;
  return null;
end $$;
drop trigger if exists crew_feed_notice on public.crew_feed;
create trigger crew_feed_notice after insert or update on public.crew_feed for each row execute function public.crew_feed_notice_trg();

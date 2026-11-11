-- Muto's app · Shoot notices for swaps and changes (11 Nov 2026, Ravi: "remind people who has switched with someone even for a
-- latest shoot", "a venue and date change should also be notified to the team"). Run once, after 018_shoot_notices.sql.
--
-- On top of "new shoot" (018), the queue now also gets:
--   removed  someone is taken off a shoot (swapped with someone else, or the shoot was cancelled) that is today or later
--   changed  a shoot they are on (today or later) changed date, time of day, report time or venue; the old values are kept
-- The server sends them within a few minutes (every 5 minutes, and at once when the owner's or manager's board saves).
-- Shoots today or tomorrow say so in the title, so a last-minute swap is not missed.

alter table public.shoot_notices add column if not exists kind text not null default 'new' check (kind in ('new', 'removed', 'changed'));
alter table public.shoot_notices add column if not exists old_date date;
alter table public.shoot_notices add column if not exists old_slot text;
alter table public.shoot_notices add column if not exists old_report text;
alter table public.shoot_notices add column if not exists old_venue text;

create or replace function public.crew_feed_notice_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare s jsonb; o jsonb; olds jsonb := '[]'::jsonb; news jsonb := '[]'::jsonb; d date; od date; t date := public.today_ist();
  okd boolean;
begin
  if tg_op = 'UPDATE' and jsonb_typeof(old.data -> 'shoots') = 'array' then olds := old.data -> 'shoots'; end if;
  if jsonb_typeof(new.data -> 'shoots') = 'array' then news := new.data -> 'shoots'; end if;
  -- new and changed
  for s in select * from jsonb_array_elements(news) loop
    if coalesce(s ->> 'id', '') = '' then continue; end if;
    okd := coalesce(s ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$';
    d := case when okd then (s ->> 'date')::date end;
    o := null;
    select x into o from jsonb_array_elements(olds) x where x ->> 'id' = s ->> 'id' limit 1;
    if o is null then
      if d is null or d < t then continue; end if;   -- only today or later
      insert into public.shoot_notices (person_key, event_id, kind, shoot, date, slot, report, venue, role)
        values (new.person_key, s ->> 'id', 'new', left(s ->> 'shoot', 160), d, left(s ->> 'slot', 30), left(s ->> 'report', 30), left(s ->> 'venue', 200), left(s ->> 'role', 80));
    elsif row(s ->> 'date', coalesce(s ->> 'slot', ''), coalesce(s ->> 'report', ''), coalesce(s ->> 'venue', '')) is distinct from row(o ->> 'date', coalesce(o ->> 'slot', ''), coalesce(o ->> 'report', ''), coalesce(o ->> 'venue', '')) then
      od := case when coalesce(o ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$' then (o ->> 'date')::date end;
      if greatest(coalesce(d, '1900-01-01'), coalesce(od, '1900-01-01')) < t then continue; end if;   -- a change to a past shoot is not news
      insert into public.shoot_notices (person_key, event_id, kind, shoot, date, slot, report, venue, role, old_date, old_slot, old_report, old_venue)
        values (new.person_key, s ->> 'id', 'changed', left(s ->> 'shoot', 160), d, left(s ->> 'slot', 30), left(s ->> 'report', 30), left(s ->> 'venue', 200), left(s ->> 'role', 80),
                od, left(o ->> 'slot', 30), left(o ->> 'report', 30), left(o ->> 'venue', 200));
    end if;
  end loop;
  -- removed (swapped with someone, or cancelled)
  for o in select * from jsonb_array_elements(olds) loop
    if coalesce(o ->> 'id', '') = '' or exists (select 1 from jsonb_array_elements(news) x where x ->> 'id' = o ->> 'id') then continue; end if;
    if coalesce(o ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' or (o ->> 'date')::date < t then continue; end if;
    insert into public.shoot_notices (person_key, event_id, kind, shoot, date, slot, report, venue, role)
      values (new.person_key, o ->> 'id', 'removed', left(o ->> 'shoot', 160), (o ->> 'date')::date, left(o ->> 'slot', 30), left(o ->> 'report', 30), left(o ->> 'venue', 200), left(o ->> 'role', 80));
  end loop;
  return null;
end $$;
-- (the trigger from 018 already calls this function)
drop trigger if exists crew_feed_notice on public.crew_feed;
create trigger crew_feed_notice after insert or update on public.crew_feed for each row execute function public.crew_feed_notice_trg();


-- Muto's app · A family's itinerary goes onto the board by itself (11 Nov 2026, Ravi). Run once, after 016_keeper_handover_only.sql.
--
-- When the family taps "Send" on their page (client_itinerary.submitted_at changes), each of their functions on the board gets:
--   location  = venue, address           mapLink = their Google Maps link
--   notes     = one line "From client: starts 7:30 pm · contact Rahul 98… · 300 guests · their notes" (replaces the previous
--               "From client:" line, so sending again does not pile up lines; the studio's own notes stay)
-- and the crew's shoot pages (crew_feed) get the same venue, map and notes at once, without waiting for the owner's board.
-- Never changed by itself: the date, the time of day, the report time, crew and gear. A family that ticks "the date or time has
-- changed" still waits for the owner (the note says so). New functions the family adds still wait in the Clients window.
-- Every change is kept in client_apply_log (old and new values) and shown in the Clients window.

create table if not exists public.client_apply_log (
  id          bigserial primary key,
  wedding_key text not null,
  event_id    text not null,
  at          timestamptz not null default now(),
  by_email    text,
  before      jsonb not null,
  after       jsonb not null
);
create index if not exists client_apply_log_key on public.client_apply_log (wedding_key, at desc);
alter table public.client_apply_log enable row level security;
drop policy if exists capply_select on public.client_apply_log;
create policy capply_select on public.client_apply_log for select to authenticated using (public.is_desk());
revoke all on public.client_apply_log from anon, authenticated;
grant select on public.client_apply_log to authenticated;

-- "19:30" → "7:30 pm"
create or replace function public.client_time12(t text) returns text language sql immutable as $$
  select case when t ~ '^\d{1,2}:\d{2}' then
    ((split_part(t, ':', 1)::int + 11) % 12 + 1)::text || ':' || substr(split_part(t, ':', 2), 1, 2) || case when split_part(t, ':', 1)::int < 12 then ' am' else ' pm' end
  else t end $$;

create or replace function public.client_apply(p_key text) returns int
  language plpgsql security definer set search_path = public as $$
declare it public.client_itinerary; ids text[]; fid text; a jsonb; d public.docs; loc text; note text; notes text; nd jsonb; n int := 0;
begin
  select * into it from public.client_itinerary where wedding_key = p_key;
  if not found then return 0; end if;
  select array_agg(f ->> 'id') into ids from public.client_feed cf, jsonb_array_elements(coalesce(cf.data -> 'functions', '[]'::jsonb)) f where cf.wedding_key = p_key;
  foreach fid in array coalesce(ids, '{}') loop
    a := it.data -> fid;
    if a is null or jsonb_typeof(a) <> 'object' then continue; end if;
    select * into d from public.docs where collection = 'events' and id = fid;
    if not found then continue; end if;
    loc := left(nullif(concat_ws(', ', nullif(trim(a ->> 'venue'), ''), nullif(trim(a ->> 'address'), '')), ''), 200);
    note := concat_ws(' · ',
      case when coalesce(trim(a ->> 'time'), '') <> '' then 'starts ' || public.client_time12(trim(a ->> 'time')) end,
      case when coalesce(trim(a ->> 'contact'), '') <> '' or coalesce(trim(a ->> 'phone'), '') <> '' then 'contact ' || concat_ws(' ', nullif(trim(a ->> 'contact'), ''), nullif(trim(a ->> 'phone'), '')) end,
      case when coalesce(trim(a ->> 'guests'), '') <> '' then trim(a ->> 'guests') || ' guests' end,
      case when coalesce((a ->> 'changed')::boolean, false) then 'DATE OR TIME CHANGED: check with the family' end,
      nullif(trim(a ->> 'notes'), ''));
    -- the studio's own notes stay; the previous "From client:" line is replaced
    notes := coalesce((select string_agg(l, E'\n') from unnest(string_to_array(coalesce(d.data ->> 'notes', ''), E'\n')) l where l <> '' and l not like 'From client:%'), '');
    if note <> '' then notes := concat_ws(E'\n', nullif(notes, ''), 'From client: ' || note); end if;
    nd := d.data;
    if loc is not null then nd := nd || jsonb_build_object('location', loc); end if;
    if coalesce(trim(a ->> 'map'), '') ~* '^https?://' then nd := nd || jsonb_build_object('mapLink', left(trim(a ->> 'map'), 500)); end if;
    nd := nd || jsonb_build_object('notes', left(notes, 2000));
    if nd is distinct from d.data then
      update public.docs set data = nd where collection = 'events' and id = fid;
      insert into public.client_apply_log (wedding_key, event_id, by_email, before, after)
        values (p_key, fid, public.my_email(), jsonb_build_object('location', d.data -> 'location', 'mapLink', d.data -> 'mapLink', 'notes', d.data -> 'notes'),
                jsonb_build_object('location', nd -> 'location', 'mapLink', nd -> 'mapLink', 'notes', nd -> 'notes'));
      -- the crew's shoot pages, at once
      update public.crew_feed f set data = jsonb_set(f.data, '{shoots}', (
          select coalesce(jsonb_agg(case when s ->> 'id' = fid then s || jsonb_build_object('venue', coalesce(nd ->> 'location', ''), 'map', coalesce(nd ->> 'mapLink', ''), 'notes', coalesce(nd ->> 'notes', '')) else s end), '[]'::jsonb)
          from jsonb_array_elements(f.data -> 'shoots') s))
        where jsonb_typeof(f.data -> 'shoots') = 'array' and exists (select 1 from jsonb_array_elements(f.data -> 'shoots') s where s ->> 'id' = fid);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.client_apply(text) from public, anon, authenticated;

-- the family pressed Send (only the family sets submitted_at, see client_save)
create or replace function public.client_itinerary_apply_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.submitted_at is not null and (tg_op = 'INSERT' or new.submitted_at is distinct from old.submitted_at) then
    perform public.client_apply(new.wedding_key);
  end if;
  return null;
end $$;
drop trigger if exists client_itinerary_apply on public.client_itinerary;
create trigger client_itinerary_apply after insert or update on public.client_itinerary for each row execute function public.client_itinerary_apply_trg();

-- 036 (23 Nov 2026, Ravi: "Report time gets updated from family's mentioned start time. Just one rule, report time converts to
-- 30 mins prior when a family updates it."). Run after 035.
-- When the family presses Send, every function where they gave a start time gets the board's report time (callTime) = their
-- start time − 30 minutes (a start before 00:30 → 00:00). The crew pages get the new report time at once, and the crew are told
-- by 019's change notice ("Report: 7:00 pm → 6:30 pm"). The studio can still change the report time on the board afterwards; the
-- next Send from the family sets it again. Date and slot are never touched. Logged in client_apply_log (callTime before/after).

-- "19:30" → "19:00"
create or replace function public.client_report(p_time text) returns text
  language sql immutable as $$
  select case when coalesce(p_time, '') ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]' then
    case when substr(p_time, 1, 5)::time < time '00:30' then '00:00' else to_char(substr(p_time, 1, 5)::time - interval '30 minutes', 'HH24:MI') end
  end $$;
-- "19:00" → "7:00 pm": client_time12() from 017

create or replace function public.client_apply(p_key text) returns int
  language plpgsql security definer set search_path = public as $$
declare it public.client_itinerary; ids text[]; fid text; a jsonb; d public.docs; loc text; note text; notes text; nd jsonb; n int := 0; rep text;
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
    note := public.client_note(a);
    notes := public.client_tidy(d.data ->> 'notes', note);
    if note <> '' then notes := concat_ws(E'\n', nullif(notes, ''), 'From client: ' || note); end if;
    nd := d.data;
    if loc is not null then nd := nd || jsonb_build_object('location', loc); end if;
    if coalesce(trim(a ->> 'map'), '') ~* '^https?://' then nd := nd || jsonb_build_object('mapLink', left(trim(a ->> 'map'), 500)); end if;
    nd := nd || jsonb_build_object('notes', left(notes, 2000));
    rep := public.client_report(a ->> 'time');
    if rep is not null then nd := nd || jsonb_build_object('callTime', rep); end if;
    if nd is distinct from d.data then
      update public.docs set data = nd where collection = 'events' and id = fid;
      insert into public.client_apply_log (wedding_key, event_id, by_email, before, after)
        values (p_key, fid, public.my_email(), jsonb_build_object('location', d.data -> 'location', 'mapLink', d.data -> 'mapLink', 'notes', d.data -> 'notes', 'callTime', d.data -> 'callTime'),
                jsonb_build_object('location', nd -> 'location', 'mapLink', nd -> 'mapLink', 'notes', nd -> 'notes', 'callTime', nd -> 'callTime'));
      update public.crew_feed f set data = jsonb_set(f.data, '{shoots}', (
          select coalesce(jsonb_agg(case when s ->> 'id' = fid then s || jsonb_build_object('venue', coalesce(nd ->> 'location', ''), 'map', coalesce(nd ->> 'mapLink', ''), 'notes', coalesce(nd ->> 'notes', ''),
              'callTime', coalesce(nd ->> 'callTime', ''), 'report', coalesce(public.client_time12(nd ->> 'callTime'), '')) else s end), '[]'::jsonb)
          from jsonb_array_elements(f.data -> 'shoots') s))
        where jsonb_typeof(f.data -> 'shoots') = 'array' and exists (select 1 from jsonb_array_elements(f.data -> 'shoots') s where s ->> 'id' = fid);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.client_apply(text) from public, anon, authenticated;

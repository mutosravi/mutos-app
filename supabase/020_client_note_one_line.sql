-- 020: the family's note goes onto the board as ONE line, and the copies already piled up are cleaned.
-- Bug (12 Nov 2026, Ravi): the family's "Anything our team should know" box takes several lines. 017 replaced
-- only the line starting "From client:", so the family's 2nd, 3rd… lines looked like studio notes, stayed,
-- and were written again on every Send (same in the manual Apply of clients.js).
-- Now: line breaks inside the family's answers become " · ", so the whole family part is one "From client:" line.
-- Clean-up below: every line that a family Send ever added (client_apply_log: after minus before) is taken out of
-- the shoot's notes, and one fresh "From client:" line is written. Studio lines and venue/map/date are not touched.
-- Run after 017 (and 018/019). Safe to run twice.

-- the family's answers for one function as one line (no "From client: " prefix)
create or replace function public.client_note(a jsonb) returns text language sql immutable as $$
  select regexp_replace(concat_ws(' · ',
      case when coalesce(trim(a ->> 'time'), '') <> '' then 'starts ' || public.client_time12(trim(a ->> 'time')) end,
      case when coalesce(trim(a ->> 'contact'), '') <> '' or coalesce(trim(a ->> 'phone'), '') <> '' then 'contact ' || concat_ws(' ', nullif(trim(a ->> 'contact'), ''), nullif(trim(a ->> 'phone'), '')) end,
      case when coalesce(trim(a ->> 'guests'), '') <> '' then trim(a ->> 'guests') || ' guests' end,
      case when coalesce((a ->> 'changed')::boolean, false) then 'DATE OR TIME CHANGED: check with the family' end,
      nullif(trim(a ->> 'notes'), '')), '\s*[\r\n]+\s*', ' · ', 'g') $$;

-- the shoot's notes without any family line: drops "From client:" lines and the given leftover lines
create or replace function public.client_strip(notes text, leftovers text[]) returns text language sql immutable as $$
  select coalesce((select string_agg(l, E'\n' order by i) from unnest(string_to_array(coalesce(notes, ''), E'\n')) with ordinality u(l, i)
    where trim(l) <> '' and l not like 'From client:%' and not (trim(l) = any (coalesce(leftovers, '{}')))), '') $$;

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
    note := public.client_note(a);
    -- the studio's own notes stay; the family's line (and any of its lines left by the old bug) is replaced
    notes := public.client_strip(d.data ->> 'notes', (select array_agg(trim(x)) from unnest(regexp_split_to_array(coalesce(a ->> 'notes', ''), '[\r\n]+')) x where trim(x) <> ''));
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

-- one-time clean-up of shoots that already have repeated family lines
do $$
declare r record; d public.docs; a jsonb; added text[]; notes text; note text; nd jsonb; fixed int := 0;
begin
  for r in select wedding_key, event_id from public.client_apply_log group by wedding_key, event_id loop
    select * into d from public.docs where collection = 'events' and id = r.event_id;
    if not found then continue; end if;
    -- every line a family Send added (after minus before), over all Sends
    select array_agg(distinct trim(l)) into added
      from public.client_apply_log g, unnest(string_to_array(coalesce(g.after ->> 'notes', ''), E'\n')) l
      where g.event_id = r.event_id and trim(l) <> ''
        and not (l = any (string_to_array(coalesce(g.before ->> 'notes', ''), E'\n')));
    notes := public.client_strip(d.data ->> 'notes', added);
    select it.data -> r.event_id into a from public.client_itinerary it where it.wedding_key = r.wedding_key;
    note := case when a is not null and jsonb_typeof(a) = 'object' then public.client_note(a) else '' end;
    if note <> '' then notes := concat_ws(E'\n', nullif(notes, ''), 'From client: ' || note); end if;
    if notes is distinct from coalesce(d.data ->> 'notes', '') then
      nd := d.data || jsonb_build_object('notes', left(notes, 2000));
      update public.docs set data = nd where collection = 'events' and id = r.event_id;
      insert into public.client_apply_log (wedding_key, event_id, by_email, before, after)
        values (r.wedding_key, r.event_id, 'cleanup-020', jsonb_build_object('location', d.data -> 'location', 'mapLink', d.data -> 'mapLink', 'notes', d.data -> 'notes'),
                jsonb_build_object('location', nd -> 'location', 'mapLink', nd -> 'mapLink', 'notes', nd -> 'notes'));
      update public.crew_feed f set data = jsonb_set(f.data, '{shoots}', (
          select coalesce(jsonb_agg(case when s ->> 'id' = r.event_id then s || jsonb_build_object('notes', coalesce(nd ->> 'notes', '')) else s end), '[]'::jsonb)
          from jsonb_array_elements(f.data -> 'shoots') s))
        where jsonb_typeof(f.data -> 'shoots') = 'array' and exists (select 1 from jsonb_array_elements(f.data -> 'shoots') s where s ->> 'id' = r.event_id);
      fixed := fixed + 1;
    end if;
  end loop;
  raise notice 'client notes cleaned on % shoot(s)', fixed;
end $$;

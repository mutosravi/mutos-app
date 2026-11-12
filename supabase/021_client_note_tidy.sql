-- 021: second clean-up of family notes on the board (12 Nov 2026, Ravi: "latest updates are correct now but earlier are
-- still repeated"). 020 removed only the lines it found in client_apply_log; copies made by the manual "Apply to board"
-- button (not logged) and older versions of a line the family later edited stayed, e.g. 6 x "rest of the team can reach
-- directly the venue … (Club Astra)" while the family's note now says "reach directly to the venue …".
-- Rule (also used from now on whenever the family sends): the studio lines of a shoot keep their order, but
--   * a line that appears again (same text, ignoring case and spaces) is kept once;
--   * a line of 4+ words whose words ALL appear in the family's own note is an old copy of it and goes.
-- Then one fresh "From client:" line. Venue, map, date, crew are not touched. Every change is in client_apply_log
-- (by_email 'cleanup-021', with the notes before) so it can be put back. Safe to run twice. Run after 020.

create or replace function public.client_words(t text) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct w), '{}') from regexp_split_to_table(lower(coalesce(t, '')), '[^[:alnum:]]+') w where w <> '' $$;

-- the shoot's own (studio) lines: no "From client:" line, no repeats, no old copies of the family's note
create or replace function public.client_tidy(notes text, fam text) returns text language plpgsql immutable as $$
declare l text; k text; seen text[] := '{}'; famw text[] := public.client_words(fam); w text[]; out text[] := '{}';
begin
  foreach l in array string_to_array(coalesce(notes, ''), E'\n') loop
    if trim(l) = '' or l like 'From client:%' then continue; end if;
    k := lower(regexp_replace(trim(l), '\s+', ' ', 'g'));
    if k = any (seen) then continue; end if;
    seen := seen || k;
    w := public.client_words(l);
    if coalesce(array_length(w, 1), 0) >= 4 and w <@ famw then continue; end if;
    out := out || l;
  end loop;
  return array_to_string(out, E'\n');
end $$;

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
    notes := public.client_tidy(d.data ->> 'notes', note);
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

-- clean every shoot that belongs to a family's form (only notes; only when something changes)
do $$
declare r record; d public.docs; note text; notes text; nd jsonb; fixed int := 0;
begin
  for r in
    select distinct cf.wedding_key, f ->> 'id' as event_id, it.data -> (f ->> 'id') as a
    from public.client_feed cf
    cross join jsonb_array_elements(coalesce(cf.data -> 'functions', '[]'::jsonb)) f
    join public.client_itinerary it on it.wedding_key = cf.wedding_key
    where jsonb_typeof(it.data -> (f ->> 'id')) = 'object'
  loop
    select * into d from public.docs where collection = 'events' and id = r.event_id;
    if not found then continue; end if;
    note := public.client_note(r.a);
    if note = '' then continue; end if;  -- the family wrote nothing for this function: leave the notes alone
    notes := concat_ws(E'\n', nullif(public.client_tidy(d.data ->> 'notes', note), ''), 'From client: ' || note);
    if notes is distinct from coalesce(d.data ->> 'notes', '') then
      nd := d.data || jsonb_build_object('notes', left(notes, 2000));
      update public.docs set data = nd where collection = 'events' and id = r.event_id;
      insert into public.client_apply_log (wedding_key, event_id, by_email, before, after)
        values (r.wedding_key, r.event_id, 'cleanup-021', jsonb_build_object('location', d.data -> 'location', 'mapLink', d.data -> 'mapLink', 'notes', d.data -> 'notes'),
                jsonb_build_object('location', nd -> 'location', 'mapLink', nd -> 'mapLink', 'notes', nd -> 'notes'));
      update public.crew_feed f set data = jsonb_set(f.data, '{shoots}', (
          select coalesce(jsonb_agg(case when s ->> 'id' = r.event_id then s || jsonb_build_object('notes', coalesce(nd ->> 'notes', '')) else s end), '[]'::jsonb)
          from jsonb_array_elements(f.data -> 'shoots') s))
        where jsonb_typeof(f.data -> 'shoots') = 'array' and exists (select 1 from jsonb_array_elements(f.data -> 'shoots') s where s ->> 'id' = r.event_id);
      fixed := fixed + 1;
    end if;
  end loop;
  raise notice 'client notes tidied on % shoot(s)', fixed;
end $$;

-- what changed today, to check by eye (Supabase shows this table after running)
select d.data ->> 'name' as shoot, l.before ->> 'notes' as notes_before, l.after ->> 'notes' as notes_now
from public.client_apply_log l left join public.docs d on d.collection = 'events' and d.id = l.event_id
where l.by_email = 'cleanup-021' and l.at > now() - interval '1 hour' order by l.at;

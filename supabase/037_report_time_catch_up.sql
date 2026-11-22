-- 037 (23 Nov 2026, Ravi: "Report time did not get update from the family's time"). Run after 036. Safe to run again.
-- 036 sets the report time when a family presses Send; forms sent BEFORE 036 were not touched. This does it once for them:
-- every shoot from today on whose family has sent the form with a start time gets report time = start − 30 minutes,
-- on the board and on the crew pages (the crew are told by 019's change notice). Past shoots are left alone.
-- Logged in client_apply_log as 'catchup-037' (report time before / after). Ends with a table of what changed.
do $$
declare r record; d public.docs; rep text; nd jsonb; n int := 0; today text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD');
begin
  for r in
    select distinct cf.wedding_key, f ->> 'id' as event_id, it.data -> (f ->> 'id') ->> 'time' as t
    from public.client_feed cf
    cross join jsonb_array_elements(coalesce(cf.data -> 'functions', '[]'::jsonb)) f
    join public.client_itinerary it on it.wedding_key = cf.wedding_key
    where it.submitted_at is not null and jsonb_typeof(it.data -> (f ->> 'id')) = 'object'
  loop
    rep := public.client_report(r.t);
    if rep is null then continue; end if;
    select * into d from public.docs where collection = 'events' and id = r.event_id;
    if not found or coalesce(d.data ->> 'date', '') < today or coalesce(d.data ->> 'callTime', '') = rep then continue; end if;
    nd := d.data || jsonb_build_object('callTime', rep);
    update public.docs set data = nd where collection = 'events' and id = r.event_id;
    insert into public.client_apply_log (wedding_key, event_id, by_email, before, after)
      values (r.wedding_key, r.event_id, 'catchup-037', jsonb_build_object('callTime', d.data -> 'callTime'), jsonb_build_object('callTime', rep));
    update public.crew_feed f set data = jsonb_set(f.data, '{shoots}', (
        select coalesce(jsonb_agg(case when s ->> 'id' = r.event_id then s || jsonb_build_object('callTime', rep, 'report', public.client_time12(rep)) else s end), '[]'::jsonb)
        from jsonb_array_elements(f.data -> 'shoots') s))
      where jsonb_typeof(f.data -> 'shoots') = 'array' and exists (select 1 from jsonb_array_elements(f.data -> 'shoots') s where s ->> 'id' = r.event_id);
    n := n + 1;
  end loop;
  raise notice 'report time set on % shoot(s)', n;
end $$;

select d.data ->> 'date' as date, d.data ->> 'name' as shoot, public.client_time12(l.before ->> 'callTime') as report_before, public.client_time12(l.after ->> 'callTime') as report_now
from public.client_apply_log l left join public.docs d on d.collection = 'events' and d.id = l.event_id
where l.by_email = 'catchup-037' and l.at > now() - interval '1 hour' order by 1;

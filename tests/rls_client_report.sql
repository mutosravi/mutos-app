-- Test for supabase/036_client_report_time.sql (after pg_stub, schema and all files up to 035, WITH 036).
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
select pg_temp.check(client_report('19:30') = '19:00' and client_report('08:15') = '07:45' and client_report('00:10') = '00:00' and client_report('') is null and client_report('soon') is null, 'start time − 30 minutes (00:10 → 00:00; nothing for an empty or odd time)');
select pg_temp.check(client_time12('19:00') = '7:00 pm' and client_time12('00:00') = '12:00 am', 'shown like the board: 7:00 pm');
insert into docs (collection, id, data) values
  ('events', 'e1', '{"id":"e1","name":"Sharma Haldi","date":"2026-12-01","slot":"Evening","callTime":"17:00","notes":"Studio line"}'),
  ('events', 'e2', '{"id":"e2","name":"Sharma Ring","date":"2026-12-02","slot":"Evening","callTime":"18:00"}');
insert into client_links (wedding_key, title, emails) values ('w:sharma', 'Sharma', '{fam@gmail.com}');
insert into client_feed (wedding_key, data) values ('w:sharma', '{"functions":[{"id":"e1"},{"id":"e2"}]}');
insert into crew_feed (person_key, name, data) values ('aman', 'Aman', '{"shoots":[{"id":"e1","shoot":"Sharma Haldi","date":"2026-12-01","slot":"Evening","callTime":"17:00","report":"5:00 pm"}]}');
insert into client_itinerary (wedding_key, data) values ('w:sharma', '{"e1":{"time":"19:30","venue":"Clarks Awadh","address":"Hazratganj"},"e2":{"venue":"Home"}}');
select pg_temp.check((select data ->> 'callTime' from docs where id = 'e1') = '17:00', 'a save without Send changes nothing');
update client_itinerary set submitted_at = now() where wedding_key = 'w:sharma';
select pg_temp.check((select data ->> 'callTime' from docs where id = 'e1') = '19:00' and (select data ->> 'date' from docs where id = 'e1') = '2026-12-01' and (select data ->> 'slot' from docs where id = 'e1') = 'Evening', 'Send: the family starts at 7:30 pm → report time 7:00 pm (date and slot untouched)');
select pg_temp.check((select data ->> 'callTime' from docs where id = 'e2') = '18:00', 'no start time given → the report time stays');
select pg_temp.check((select s ->> 'report' from crew_feed, jsonb_array_elements(data -> 'shoots') s where s ->> 'id' = 'e1') = '7:00 pm' and (select s ->> 'callTime' from crew_feed, jsonb_array_elements(data -> 'shoots') s where s ->> 'id' = 'e1') = '19:00', 'the crew page shows Report 7:00 pm at once');
select pg_temp.check((select before ->> 'callTime' from client_apply_log where event_id = 'e1' order by at desc limit 1) = '17:00' and (select after ->> 'callTime' from client_apply_log where event_id = 'e1' order by at desc limit 1) = '19:00', 'logged: 17:00 → 19:00');
select pg_temp.check(exists (select 1 from shoot_notices where person_key = 'aman' and event_id = 'e1' and kind = 'changed' and old_report = '5:00 pm'), 'the crew are told the report time changed');
-- the studio moves it by hand; the family's next Send sets it again
update docs set data = data || '{"callTime":"18:15"}' where id = 'e1';
update client_itinerary set data = jsonb_set(data, '{e1,time}', '"20:00"'), submitted_at = now() + interval '1 minute' where wedding_key = 'w:sharma';
select pg_temp.check((select data ->> 'callTime' from docs where id = 'e1') = '19:30', 'family changes the start to 8 pm → report 7:30 pm');
-- 037: forms sent before 036 get the rule once (future shoots only)
insert into docs (collection, id, data) values
  ('events', 'f1', jsonb_build_object('id','f1','name','Gupta Haldi','date', to_char(now() + interval '5 days', 'YYYY-MM-DD'),'callTime','10:00')),
  ('events', 'f2', jsonb_build_object('id','f2','name','Gupta Old','date', '2020-01-01','callTime','10:00'));
alter table client_itinerary disable trigger user;
insert into client_links (wedding_key, title, emails) values ('w:gupta', 'Gupta', '{g@gmail.com}');
insert into client_feed (wedding_key, data) values ('w:gupta', '{"functions":[{"id":"f1"},{"id":"f2"}]}');
insert into client_itinerary (wedding_key, data, submitted_at) values ('w:gupta', '{"f1":{"time":"18:45"},"f2":{"time":"18:45"}}', now() - interval '3 days');
alter table client_itinerary enable trigger user;
select pg_temp.check((select data ->> 'callTime' from docs where id = 'f1') = '10:00', 'before 037: a form sent before 036 still has the old report time');
\ir ../supabase/037_report_time_catch_up.sql
select pg_temp.check((select data ->> 'callTime' from docs where id = 'f1') = '18:15' and (select data ->> 'callTime' from docs where id = 'f2') = '10:00', '037: coming shoot set to 6:15 pm, past shoot left alone');
\ir ../supabase/037_report_time_catch_up.sql
select pg_temp.check((select count(*) from client_apply_log where by_email = 'catchup-037') = 1, 'running 037 again changes nothing');

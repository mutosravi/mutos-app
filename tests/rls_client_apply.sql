-- Test for supabase/017_client_auto_apply.sql (after pg_stub, schema, 002–005, 007–016, 017).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('s@x.com','supervisor',null,'Sup',now()),('c@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;
insert into docs (collection, id, data) values
  ('events', 'e1', '{"id":"e1","name":"Akriti Haldi","date":"2026-12-01","slot":"Morning","callTime":"09:00","location":"Lucknow","notes":"Bring the drone\nFrom client: old line","assignments":[{"memberId":"m1"}]}'),
  ('events', 'e2', '{"id":"e2","name":"Akriti Wedding","date":"2026-12-02","slot":"Evening","location":"Lucknow","notes":""}');
insert into client_links (wedding_key, title, emails) values ('w:akriti', 'Akriti & Rohan', '{akriti@gmail.com}');
insert into client_feed (wedding_key, data) values ('w:akriti', '{"functions":[{"id":"e1","name":"Akriti Haldi"},{"id":"e2","name":"Akriti Wedding"}]}');
insert into crew_feed (person_key, name, data) values ('hamza', 'Hamza', '{"shoots":[{"id":"e1","shoot":"Akriti Haldi","venue":"Lucknow","map":"","notes":"Bring the drone"},{"id":"x9","shoot":"Other","venue":"Kanpur"}]}');
select set_config('t.tok', (select token::text from client_links), false);

-- the family fills Haldi and saves without sending: nothing changes on the board yet
set role authenticated; set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select client_save(current_setting('t.tok')::uuid, '{"e1":{"time":"19:30","venue":"Taj Mahal Hotel","address":"Gomti Nagar","map":"https://maps.app.goo.gl/x","contact":"Rahul","phone":"9876511111","guests":"300","notes":"Couple entry 8 pm"}}', false);
reset role;
select pg_temp.check((select data ->> 'location' from docs where id = 'e1') = 'Lucknow', 'saving without Send does not touch the board (no half-typed venues)');
-- Send
set role authenticated; set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select client_save(current_setting('t.tok')::uuid, '{"e1":{"time":"19:30","venue":"Taj Mahal Hotel","address":"Gomti Nagar","map":"https://maps.app.goo.gl/x","contact":"Rahul","phone":"9876511111","guests":"300","notes":"Couple entry 8 pm"}}', true);
reset role;
select pg_temp.check((select data ->> 'location' from docs where id = 'e1') = 'Taj Mahal Hotel, Gomti Nagar' and (select data ->> 'mapLink' from docs where id = 'e1') = 'https://maps.app.goo.gl/x', 'Send: venue, address and map go onto the board by themselves');
select pg_temp.check((select data ->> 'notes' from docs where id = 'e1') = E'Bring the drone\nFrom client: starts 7:30 pm · contact Rahul 9876511111 · 300 guests · Couple entry 8 pm', 'notes: the studio''s line stays, the family''s line replaces the old one (start time as 7:30 pm)');
select pg_temp.check((select data ->> 'date' from docs where id = 'e1') = '2026-12-01' and (select data ->> 'callTime' from docs where id = 'e1') = '09:00' and (select data -> 'assignments' -> 0 ->> 'memberId' from docs where id = 'e1') = 'm1', 'date, report time and crew are never changed');
select pg_temp.check((select s ->> 'venue' from crew_feed, jsonb_array_elements(data -> 'shoots') s where s ->> 'id' = 'e1') = 'Taj Mahal Hotel, Gomti Nagar'
  and (select s ->> 'venue' from crew_feed, jsonb_array_elements(data -> 'shoots') s where s ->> 'id' = 'x9') = 'Kanpur', 'the crew''s shoot page shows the new venue at once (other shoots untouched)');
select pg_temp.check((select count(*) from client_apply_log) = 1 and (select before ->> 'location' from client_apply_log) = 'Lucknow', 'the change is logged with the old venue');
-- sending again with the same answers changes nothing; a date change is flagged, not applied
set role authenticated; set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select client_save(current_setting('t.tok')::uuid, '{"e1":{"time":"19:30","venue":"Taj Mahal Hotel","address":"Gomti Nagar","map":"https://maps.app.goo.gl/x","contact":"Rahul","phone":"9876511111","guests":"300","notes":"Couple entry 8 pm"}}', true);
reset role;
select pg_temp.check((select count(*) from client_apply_log) = 1 and (select data ->> 'notes' from docs where id = 'e1') not like '%From client%From client%', 'sending the same again adds nothing');
set role authenticated; set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select client_save(current_setting('t.tok')::uuid, '{"e1":{"venue":"Taj Mahal Hotel","changed":true,"notes":"Moved to 3 Dec"},"e2":{"venue":"Home"}}', true);
reset role;
select pg_temp.check((select data ->> 'date' from docs where id = 'e1') = '2026-12-01' and (select data ->> 'notes' from docs where id = 'e1') like '%DATE OR TIME CHANGED: check with the family%Moved to 3 Dec%', 'a date change is flagged in the notes for the studio, never applied');
select pg_temp.check((select data ->> 'location' from docs where id = 'e2') = 'Home', 'the other function is applied too');
-- the studio editing the form does not apply anything (only the family's Send)
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select client_save(current_setting('t.tok')::uuid, '{"e2":{"venue":"Changed by studio"}}', false);
select pg_temp.check((select count(*) from client_apply_log) = 3, 'the supervisor sees the log');
reset role;
select pg_temp.check((select data ->> 'location' from docs where id = 'e2') = 'Home', 'a studio edit of the form is not applied by itself');
set role authenticated; set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check((select count(*) from client_apply_log) = 0, 'crew do not see the log');
select pg_temp.expect_fail($$select client_apply('w:akriti')$$, 'and nobody can run it by hand');
reset role;
select 'ALL CLIENT APPLY CHECKS PASSED';

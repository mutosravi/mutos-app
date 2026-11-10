-- Access-rule test for supabase/012_supervisor.sql (after pg_stub, schema, 002–005, 007–011, 012).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('s@x.com','supervisor',null,'Sup',now()),
  ('c@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;

-- the owner's board: an old shoot with crew and gear, a shooter, the Team Alignment settings
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into docs (collection, id, data) values
  ('events', 'old1', '{"id":"old1","name":"Akriti Mehndi","wedding":"Akriti","date":"2026-12-01","slot":"Morning","coverage":"2+2","tier":"Premium","location":"Lucknow","callTime":"09:00","contactName":"Mr Verma","contactPhone":"98765","notes":"","mapLink":"","status":"confirmed","eventType":"short","assignments":[{"memberId":"sh1","gearIds":["g1"]}],"equipmentIds":["g2"],"assistantIds":[]}'),
  ('shooters', 'sh1', '{"id":"sh1","name":"Hamza","rateShort":3000}'),
  ('settings', 'main', '{"id":"main"}');
insert into client_links (wedding_key, title, emails) values ('w:akriti', 'Akriti & Rohan', '{akriti@gmail.com}');
insert into bookings (wedding_key, title, total) values ('w:akriti', 'Akriti & Rohan', 300000);
insert into people (name, email) values ('Editor One', 'ed@x.com');
reset role;
select pg_temp.check((select created_by from docs where id = 'old1') = 'o@x.com', 'new records remember who added them');
select set_config('t.tok', (select token::text from client_links), false);

-- ── the supervisor ──
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((select count(*) from docs) = 3, 'he sees the board');
-- itinerary and client contact: allowed
update docs set data = data || '{"date":"2026-12-02","slot":"Evening","callTime":"17:00","location":"Clarks Avadh","mapLink":"https://maps.app/x","contactName":"Mrs Verma","contactPhone":"99999","notes":"Gate 2","name":"Akriti Mehndi (night)"}' where id = 'old1';
select pg_temp.check((select data ->> 'location' = 'Clarks Avadh' and data ->> 'date' = '2026-12-02' and data ->> 'contactPhone' = '99999' from docs where id = 'old1'), 'changes date, slot, time, venue, map, client contact, notes and name');
-- an upsert of the whole record (what the board sends) with only those changes: allowed
insert into docs (collection, id, data) select 'events', 'old1', data || '{"notes":"Gate 3"}' from docs where id = 'old1'
  on conflict (collection, id) do update set data = excluded.data;
select pg_temp.check((select data ->> 'notes' from docs where id = 'old1') = 'Gate 3', 'the board''s save of the whole shoot works when only allowed fields changed');
-- crew, gear, coverage, tier, cancel, wedding: refused
select pg_temp.expect_fail($$update docs set data = jsonb_set(data, '{assignments}', '[]') where id = 'old1'$$, 'removing the crew');
select pg_temp.expect_fail($$update docs set data = jsonb_set(data, '{assignments}', '[{"memberId":"sh1","gearIds":[]}]') where id = 'old1'$$, 'taking a shooter''s gear');
select pg_temp.expect_fail($$update docs set data = jsonb_set(data, '{equipmentIds}', '[]') where id = 'old1'$$, 'changing shared gear');
select pg_temp.expect_fail($$update docs set data = data || '{"coverage":"1+1"}' where id = 'old1'$$, 'changing coverage');
select pg_temp.expect_fail($$update docs set data = data || '{"tier":"Standard"}' where id = 'old1'$$, 'changing the client tier');
select pg_temp.expect_fail($$update docs set data = data || '{"status":"cancelled"}' where id = 'old1'$$, 'cancelling a shoot');
select pg_temp.expect_fail($$update docs set data = data || '{"wedding":"Other"}' where id = 'old1'$$, 'moving it to another wedding');
select pg_temp.expect_fail($$insert into docs (collection, id, data) select 'events', 'old1', data || '{"coverage":"9+9"}' from docs where id = 'old1' on conflict (collection, id) do update set data = excluded.data$$, 'sneaking a coverage change through the board''s save');
-- deleting an old shoot: nothing happens
delete from docs where id = 'old1';
select pg_temp.check((select count(*) from docs where id = 'old1') = 1, 'he cannot delete an older shoot');
-- other parts of the board: refused
update docs set data = data || '{"rateShort":9999}' where id = 'sh1';
select pg_temp.check((select data ->> 'rateShort' from docs where id = 'sh1') = '3000', 'he cannot change a shooter''s rate');
select pg_temp.expect_fail($$insert into docs (collection, id, data) values ('shooters', 'sh2', '{"id":"sh2","name":"New"}')$$, 'adding a shooter');
select pg_temp.expect_fail($$insert into docs (collection, id, data) values ('away', 'a1', '{"id":"a1"}')$$, 'marking someone away');
select pg_temp.expect_fail($$insert into docs (collection, id, data) values ('settings', 's2', '{}')$$, 'changing settings');
delete from docs where id = 'sh1';
select pg_temp.check((select count(*) from docs where id = 'sh1') = 1, 'he cannot delete a shooter');
-- new shoots: allowed without crew or gear (empty slots are fine)
insert into docs (collection, id, data) values ('events', 'new1', '{"id":"new1","name":"Akriti Haldi","date":"2026-12-03","coverage":"2+2","assignments":[{"memberId":"","gearIds":[]},{"memberId":null,"gearIds":[]}],"equipmentIds":[],"assistantIds":[]}');
select pg_temp.check((select created_by from docs where id = 'new1') = 's@x.com', 'adds a new shoot (his name on it)');
select pg_temp.expect_fail($$insert into docs (collection, id, data) values ('events', 'new2', '{"id":"new2","name":"X","assignments":[{"memberId":"sh1","gearIds":[]}],"equipmentIds":[],"assistantIds":[]}')$$, 'a new shoot with crew on it');
select pg_temp.expect_fail($$insert into docs (collection, id, data) values ('events', 'new3', '{"id":"new3","name":"X","assignments":[],"equipmentIds":["g1"],"assistantIds":[]}')$$, 'a new shoot with gear on it');
update docs set created_by = 's@x.com', created_at = now() where id = 'old1';
select pg_temp.check((select created_by from docs where id = 'old1') = 'o@x.com', 'he cannot make an old shoot look like his own');
delete from docs where id = 'old1';
select pg_temp.check((select count(*) from docs where id = 'old1') = 1, '… so it still cannot be deleted');
insert into docs (collection, id, data) values ('history', 'h1', '{"lines":["Added Akriti Haldi"]}');
select pg_temp.check((select count(*) from docs where collection = 'history') = 1, 'his changes go into the history');
-- his own new shoot, within the hour: he can delete it
delete from docs where id = 'new1';
select pg_temp.check((select count(*) from docs where id = 'new1') = 0, 'deletes his own new shoot within the hour');
insert into docs (collection, id, data) values ('events', 'new4', '{"id":"new4","name":"Akriti Sangeet","assignments":[],"equipmentIds":[],"assistantIds":[]}');
reset role;
alter table docs disable trigger docs_stamp; update docs set created_at = now() - interval '2 hours' where id = 'new4'; alter table docs enable trigger docs_stamp;
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
delete from docs where id = 'new4';
select pg_temp.check((select count(*) from docs where id = 'new4') = 1, 'after an hour his shoot stays');
-- the manager's shoots are not his to delete even when new
reset role; set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into docs (collection, id, data) values ('events', 'mgr1', '{"id":"mgr1","name":"M","assignments":[{"memberId":"sh1","gearIds":["g1"]}],"equipmentIds":[],"assistantIds":[]}');
update docs set data = jsonb_set(data, '{assignments}', '[]') where id = 'old1';
select pg_temp.check((select data -> 'assignments' from docs where id = 'old1') = '[]', 'the manager still changes crew as before');
reset role; set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
delete from docs where id = 'mgr1';
select pg_temp.check((select count(*) from docs where id = 'mgr1') = 1, 'he cannot delete a shoot the manager just added');
-- the board's save path for him (sup_save_event): an older-layout shoot takes only his fields, the rest stays as stored
reset role; set request.jwt.claims = '{"email":"o@x.com"}';
insert into docs (collection, id, data) values ('events', 'legacy1', '{"id":"legacy1","name":"Old Layout Mehndi","date":"2026-12-05","coverage":"2+2","oldKey":"x","assignments":[{"memberId":"sh1","gearIds":["g1"],"role":"Cine"}],"equipmentIds":[],"noteSent":"Gate 1","notes":"Gate 1"}');
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((sup_save_event('legacy1', '{"id":"legacy1","name":"Old Layout Mehndi","date":"2026-12-06","slot":"Evening","coverage":"1+1","status":"cancelled","eventType":"full","location":"Hotel X","notes":"Gate 4","assignments":[],"equipmentIds":["g9"],"assistantIds":[]}')) ? 'ok', 'his board''s save of an older-layout shoot goes through');
select pg_temp.check((select data ->> 'date' = '2026-12-06' and data ->> 'slot' = 'Evening' and data ->> 'location' = 'Hotel X' and data ->> 'notes' = 'Gate 4' from docs where id = 'legacy1'), '… his date, slot, venue and notes are saved');
select pg_temp.check((select data ->> 'coverage' = '2+2' and data ->> 'oldKey' = 'x' and not (data ? 'status') and not (data ? 'eventType') and data -> 'assignments' = '[{"memberId":"sh1","gearIds":["g1"],"role":"Cine"}]' and data -> 'equipmentIds' = '[]' from docs where id = 'legacy1'), '… crew, gear, coverage, cancelling and everything else stay exactly as stored');
select pg_temp.check((select not (data ? 'noteSent') from docs where id = 'legacy1'), '… a field his board cleared (note sent mark) is cleared');
select pg_temp.expect_fail($$select sup_save_event('new9', '{"id":"new9","name":"X","assignments":[{"memberId":"sh1","gearIds":[]}],"equipmentIds":[],"assistantIds":[]}')$$, 'a new shoot with crew through his save path');
select pg_temp.check((sup_save_event('new8', '{"id":"new8","name":"Akriti Tilak","assignments":[],"equipmentIds":[],"assistantIds":[]}')) ? 'ok', 'a new shoot through his save path');
select pg_temp.check((select created_by from docs where id = 'new8') = 's@x.com', '… with his name on it');
reset role; set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((sup_save_event('legacy1', '{"location":"Y"}')) ? 'error', 'the save path is only for the supervisor');
reset role; set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';

-- crew pages and gear desk follow his changes; he cannot remove a crew page
insert into crew_feed (person_key, name, data) values ('hamza', 'Hamza', '{"shoots":[]}');
update crew_feed set data = '{"shoots":[{"id":"old1"}]}' where person_key = 'hamza';
delete from crew_feed where person_key = 'hamza';
select pg_temp.check((select count(*) from crew_feed) = 1, 'updates crew pages, cannot delete them');
insert into gear_feed (id, data) values ('main', '{"items":[]}') on conflict (id) do update set data = excluded.data;
select pg_temp.check((select count(*) from gear_feed) = 1, 'updates the gear desk''s view');

-- ── clients, without money ──
select pg_temp.check((select count(*) from client_links) = 1, 'sees the client links');
update client_links set emails = '{akriti@gmail.com,rohan@gmail.com}';
select pg_temp.check((select emails from client_links) = '{akriti@gmail.com,rohan@gmail.com}', 'adds a family Gmail');
delete from client_links;
select pg_temp.check((select count(*) from client_links) = 1, 'cannot delete a client link');
insert into client_feed (wedding_key, data) values ('w:akriti', '{"functions":[]}');
select pg_temp.check((select count(*) from bookings) = 0 and (select count(*) from booking_payments) = 0 and (select count(*) from packages) = 0, 'no packages, bookings or payments');
select pg_temp.expect_fail($$insert into booking_payments (wedding_key, amount) values ('w:akriti', 5000)$$, 'recording a payment');
select pg_temp.check((client_get(current_setting('t.tok')::uuid)) ->> 'studio_edit' = 'true' and (client_get(current_setting('t.tok')::uuid)) -> 'booking' = 'null'::jsonb, 'opens the family''s page to edit, without the money');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, '{"old1":{"venue":"Clarks"}}', true)) ? 'ok', 'edits the family''s form for them');
reset role;
select pg_temp.check((select data #>> '{old1,venue}' = 'Clarks' and updated_by = 's@x.com' and submitted_at is null from client_itinerary), 'saved with his name; it does not count as "sent by the family"');
-- the family still sends it themselves
set role authenticated; set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select pg_temp.check((client_save(current_setting('t.tok')::uuid, '{"old1":{"venue":"Clarks Avadh"}}', true)) ? 'ok', 'the family saves and sends');
reset role;
select pg_temp.check((select submitted_at is not null and updated_by = 'akriti@gmail.com' from client_itinerary), 'the family''s send is recorded');
-- the owner can also edit for the family now
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((client_save(current_setting('t.tok')::uuid, '{"old1":{"venue":"Clarks Avadh, Hall 2"}}', false)) ? 'ok', 'the owner can edit the family''s form too');
-- crew still cannot open a family's page
reset role; set role authenticated; set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check((client_get(current_setting('t.tok')::uuid)) ? 'error', 'crew cannot open a family''s page');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, '{}', false)) ? 'error', 'crew cannot change a family''s page');

-- ── work desk ──
reset role; set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((select count(*) from people) >= 1 and (select count(*) from people_directory()) >= 1, 'sees the people names');
select pg_temp.check((select count(*) from people_private) = 0, 'no private details (address, UPI, ID)');
select pg_temp.expect_fail($$insert into people (name) values ('Someone')$$, 'adding to the people register');
insert into work_jobs (wedding_key, wedding_title, wedding_date, kind, fn_label, assignee, due)
  values ('w:akriti', 'Akriti & Rohan', '2026-12-01', 'reel', 'Mehndi', (select id from people where name = 'Editor One'), '2026-12-10');
update work_jobs set status = 'final';
select pg_temp.check((select status = 'final' and done_at is not null from work_jobs), 'assigns a job and marks it final, like the manager');
delete from work_jobs;
select pg_temp.check((select count(*) from work_jobs) = 1, 'cannot delete a job');
select pg_temp.check((select count(*) from drives) >= 0, 'can read the drive register');
select pg_temp.check((select count(*) from salary_history) = 0 and (select count(*) from payroll_runs) = 0, 'no salaries');
select pg_temp.expect_fail($$insert into members (email, role) values ('x@x.com', 'manager')$$, 'adding a login');
reset role;
select 'ALL SUPERVISOR CHECKS PASSED';

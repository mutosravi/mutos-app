-- Test for supabase/018_shoot_notices.sql (after pg_stub, schema, 002–005, 007–017, 018).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('c@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
select set_config('t.d1', (today_ist() + 3)::text, false), set_config('t.d0', (today_ist() - 2)::text, false);
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
-- the board writes Hamza's page for the first time: his upcoming shoot is new to him, a past one is not announced
insert into crew_feed (person_key, name, data) values ('hamza', 'Hamza', jsonb_build_object('shoots', jsonb_build_array(
  jsonb_build_object('id', 'e1', 'date', current_setting('t.d1'), 'shoot', 'Sharma Haldi', 'slot', 'Morning', 'report', '9:00 am', 'venue', 'Taj', 'role', 'Candid'),
  jsonb_build_object('id', 'e0', 'date', current_setting('t.d0'), 'shoot', 'Old shoot', 'slot', 'Evening'))));
reset role;
select pg_temp.check((select count(*) from shoot_notices) = 1 and (select shoot from shoot_notices) = 'Sharma Haldi' and (select report from shoot_notices) = '9:00 am', 'a new upcoming shoot is queued (the past one is not)');
-- the board writes the same list again, and then changes the venue: not new
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
update crew_feed set data = jsonb_set(data, '{shoots,0,venue}', '"Clarks"') where person_key = 'hamza';
select pg_temp.check((select count(*) from crew_feed) = 1, 'the owner keeps the page');
reset role;
select pg_temp.check((select count(*) from shoot_notices) = 1, 'a changed venue is not a new shoot');
-- a second shoot is assigned
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
update crew_feed set data = jsonb_set(data, '{shoots}', (data -> 'shoots') || jsonb_build_array(jsonb_build_object('id', 'e2', 'date', current_setting('t.d1'), 'shoot', 'Sharma Wedding', 'slot', 'Evening'))) where person_key = 'hamza';
reset role;
select pg_temp.check((select count(*) from shoot_notices) = 2 and (select count(*) from shoot_notices where event_id = 'e2') = 1, 'a newly assigned shoot is queued');
-- removed, then put back: told again
update crew_feed set data = jsonb_build_object('shoots', jsonb_build_array(data -> 'shoots' -> 0)) where person_key = 'hamza';
update crew_feed set data = jsonb_set(data, '{shoots}', (data -> 'shoots') || jsonb_build_array(jsonb_build_object('id', 'e2', 'date', current_setting('t.d1'), 'shoot', 'Sharma Wedding', 'slot', 'Evening'))) where person_key = 'hamza';
select pg_temp.check((select count(*) from shoot_notices where event_id = 'e2') = 2, 'removed and put back: told again');
set role authenticated; set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check((select count(*) from information_schema.role_table_grants where table_name = 'shoot_notices' and grantee = 'authenticated') = 0, 'nobody in the app can read or change the queue (only the server)');
reset role;
select 'ALL SHOOT NOTICE CHECKS PASSED';

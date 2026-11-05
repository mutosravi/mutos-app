-- Access-rule test for supabase/003_gear_desk.sql (after pg_stub, schema, 002, 003).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('a@x.com','crew','anurag','Anurag',now()),('b@x.com','crew','basu','Basu',now()),('m@x.com','manager',null,'Mgr',now()) on conflict do nothing;
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;

-- owner adds a gear manager
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into members (email, role, display_name) values ('g@x.com', 'gear', 'Gear Guy');
insert into gear_feed (id, data) values ('main', '{"items":[]}');
reset role;
select pg_temp.check((select role from members where email='g@x.com')='gear', 'owner can add a gear manager');

-- gear manager
set role authenticated; set request.jwt.claims = '{"email":"g@x.com"}';
select pg_temp.check((select count(*) from gear_feed)=1, 'gear manager reads the gear schedule');
select pg_temp.check((select count(*) from docs)=0 and (select count(*) from crew_feed)=0 and (select count(*) from crew_status)=0, 'gear manager sees no board, crew pages or client details');
insert into gear_log (gear_id, gear_name, action, person_key, person_name, condition, by_email) values ('g1','FX3','out','anurag','Anurag','good','someone@else.com');
select pg_temp.check((select by_email from gear_log limit 1)='g@x.com', 'entry is signed by the gear manager, cannot be faked');
insert into gear_log (gear_id, gear_name, action, person_key, person_name, condition, note) values ('g1','FX3','in','anurag','Anurag','damaged','LCD cracked');
select pg_temp.expect_fail($$update gear_log set condition='good'$$, 'editing a log entry');
update gear_feed set data='{}'; -- under the rules this silently changes nothing
select pg_temp.check((select data from gear_feed)='{"items":[]}'::jsonb, 'schedule unchanged');
select pg_temp.expect_fail($$insert into members (email, role) values ('x@x.com','gear')$$, 'gear manager adding logins');
delete from gear_log where condition='damaged';
select pg_temp.check((select count(*) from gear_log)=1, 'gear manager can remove own fresh entry');
reset role;
update gear_log set created_at = now() - interval '2 hours';
set role authenticated; set request.jwt.claims = '{"email":"g@x.com"}';
delete from gear_log;
select pg_temp.check((select count(*) from gear_log)=1, 'but not after an hour');
reset role;

-- crew
set role authenticated; set request.jwt.claims = '{"email":"a@x.com"}';
select pg_temp.check((select count(*) from gear_log)=1, 'Anurag sees entries about himself');
select pg_temp.check((select count(*) from gear_feed)=0, 'crew cannot read the gear schedule');
select pg_temp.expect_fail($$insert into gear_log (gear_id, gear_name, action, person_key, person_name) values ('g1','FX3','in','anurag','Anurag')$$, 'crew writing the log');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"b@x.com"}';
select pg_temp.check((select count(*) from gear_log)=0, 'Basu sees nothing of Anurag''s');
reset role;

-- manager and owner
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from gear_log)=1 and (select count(*) from gear_feed)=1, 'manager sees the desk');
delete from gear_log; select pg_temp.check((select count(*) from gear_log)=1, 'manager cannot delete old entries');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
delete from gear_log; select pg_temp.check((select count(*) from gear_log)=0, 'owner can remove a wrong entry');
reset role;
set role anon;
select pg_temp.expect_fail($$select * from gear_log$$, 'signed-out read');
reset role;
\echo ALL GEAR DESK CHECKS PASSED

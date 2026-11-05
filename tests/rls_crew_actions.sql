-- Access-rule test for supabase/002_crew_actions.sql. Run on a scratch Postgres after tests/pg_stub.sql, schema.sql and 002.
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('a@x.com','crew','anurag','Anurag',now()),('b@x.com','crew','basu','Basu',now()),('m@x.com','manager',null,'Mgr',now()) on conflict do nothing;
insert into crew_feed values ('anurag','Anurag', jsonb_build_object('shoots', jsonb_build_array(
   jsonb_build_object('id','ev1','date',to_char(today_ist()+10,'YYYY-MM-DD')),
   jsonb_build_object('id','ev0','date',to_char(today_ist()-5,'YYYY-MM-DD')))), now()),
 ('basu','Basu', jsonb_build_object('shoots', jsonb_build_array(jsonb_build_object('id','ev3','date',to_char(today_ist()+12,'YYYY-MM-DD')))), now())
 on conflict do nothing;
grant usage on schema public to authenticated;

create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;

-- ── crew Anurag ──
set role authenticated; set request.jwt.claims = '{"email":"A@x.com"}';
insert into crew_away (person_key, date, reason) values ('anurag', today_ist()+30, 'Family function');
select pg_temp.check((select status='auto' and why='' from crew_away where date=today_ist()+30), 'free date far ahead is accepted straight away');
insert into crew_away (person_key, date) values ('anurag', today_ist()+10);
select pg_temp.check((select status='pending' and why='booked' from crew_away where date=today_ist()+10), 'booked date becomes a request');
insert into crew_away (person_key, date, slot) values ('anurag', today_ist()+3, 'Evening');
select pg_temp.check((select status='pending' and why='soon' from crew_away where date=today_ist()+3), 'date within 7 days becomes a request');
insert into crew_away (person_key, date, status) values ('basu', today_ist()+40, 'approved');
select pg_temp.check((select person_key='anurag' and status='auto' from crew_away where date=today_ist()+40), 'cannot forge status or another person');
select pg_temp.expect_fail($$insert into crew_away (date) values (today_ist()-1)$$, 'past date');
update crew_away set status='approved' where date=today_ist()+10;
select pg_temp.check((select status from crew_away where date=today_ist()+10)='pending', 'request still pending');
insert into crew_status (person_key, event_id, confirm) values ('anurag','ev1','yes');
insert into crew_status (person_key, event_id, data_at) values ('anurag','ev0',now());
update crew_status set confirm='no', confirm_note='sick' where event_id='ev1';
select pg_temp.check((select confirm='no' from crew_status where event_id='ev1'), 'crew updates own answer');
select pg_temp.expect_fail($$insert into crew_status (person_key, event_id, confirm) values ('anurag','ev3','yes')$$, 'answer for a shoot not theirs');
select pg_temp.expect_fail($$insert into crew_status (person_key, event_id, confirm) values ('basu','ev3','yes')$$, 'answer as someone else');
insert into push_subs (endpoint, person_key, p256dh, auth) values ('https://push/1','anurag','k','a');
select pg_temp.expect_fail($$insert into push_subs (endpoint, person_key, p256dh, auth) values ('https://push/2','basu','k','a')$$, 'reminder sign-up for someone else');
select pg_temp.expect_fail($$insert into crew_feed values ('anurag','x','{}',now())$$, 'crew still cannot write own page');
reset role;

-- ── crew Basu ──
set role authenticated; set request.jwt.claims = '{"email":"b@x.com"}';
select pg_temp.check((select count(*) from crew_away)=0 and (select count(*) from crew_status)=0 and (select count(*) from push_subs)=0, 'Basu sees none of Anurag''s rows');
delete from crew_away; select pg_temp.check(true, 'Basu delete ran');
reset role;
select pg_temp.check((select count(*) from crew_away)=4, 'Basu deleted nothing of Anurag''s');

-- ── manager ──
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from crew_away)=4 and (select count(*) from crew_status)=2, 'manager sees all requests and answers');
update crew_away set status='approved' where date=today_ist()+10;
select pg_temp.check((select status='approved' and decided_at is not null from crew_away where date=today_ist()+10), 'manager approves, decision time recorded');
update crew_away set status='declined' where date=today_ist()+3;
select pg_temp.check((select count(*) from push_subs)=0, 'manager does not see phone sign-ups');
reset role;

-- ── crew withdraws ──
set role authenticated; set request.jwt.claims = '{"email":"a@x.com"}';
delete from crew_away where date=today_ist()+30;
select pg_temp.check((select count(*) from crew_away where date=today_ist()+30)=0, 'crew takes back own date');
reset role;

-- ── signed out ──
set role anon;
select pg_temp.expect_fail($$select * from crew_away$$, 'signed-out read');
select pg_temp.expect_fail($$insert into crew_status (person_key,event_id) values ('anurag','ev1')$$, 'signed-out write');
reset role;
\echo ALL RLS CHECKS PASSED

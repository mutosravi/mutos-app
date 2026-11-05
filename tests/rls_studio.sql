-- Access-rule test for supabase/004_studio.sql (after pg_stub, schema, 002, 003, 004).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('acc@x.com','accountant',null,'Acc',now()),('s@x.com','staff',null,'Staff',now()),
  ('c@x.com','crew','hamza','Hamza',now()),('k@x.com','kiosk',null,'Office',now()),('m@x.com','manager',null,'Mgr',now()) on conflict do nothing;
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;

-- ── clients: sign in with the Gmail the studio registered ──
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into client_links (wedding_key, title, phone, emails) values ('akriti', 'Akriti & Rohan', '9876500000', '{" Akriti@Gmail.com ","rohan@gmail.com"}');
insert into client_feed (wedding_key, data) values ('akriti', '{"functions":[{"id":"e1","name":"Akriti Mehndi","date":"2026-12-01"}]}');
reset role;
select pg_temp.check((select emails from client_links) = '{akriti@gmail.com,rohan@gmail.com}', 'client Gmails are stored in lower case');
select set_config('t.tok', (select token::text from client_links where wedding_key='akriti'), false);
set role anon; set request.jwt.claims = '{}';
select pg_temp.expect_fail($$select * from client_links$$, 'visitor reading the list of links');
select pg_temp.expect_fail($$select client_get(current_setting('t.tok')::uuid)$$, 'visitor who is not signed in opening the page');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"stranger@gmail.com"}';
select pg_temp.check(jsonb_array_length(client_list()) = 0, 'a Gmail not on the list sees no wedding');
select pg_temp.check((client_get(current_setting('t.tok')::uuid)) ? 'not_listed', 'a Gmail not on the list cannot open it');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, '{"e1":{"venue":"x"}}', false)) ? 'error', 'and cannot fill it');
set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select pg_temp.check(client_list() -> 0 ->> 'title' = 'Akriti & Rohan', 'the family Gmail sees its wedding');
select pg_temp.check(client_get(gen_random_uuid()) ? 'error', 'wrong page shows an error');
select pg_temp.check(client_get(current_setting('t.tok')::uuid) ->> 'title' = 'Akriti & Rohan' and jsonb_array_length(client_get(current_setting('t.tok')::uuid) -> 'functions') = 1, 'client page shows their functions');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, '{"e1":{"venue":"Taj"}}', false)) ? 'ok', 'client saves a draft');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, '{"e1":{"venue":"Taj Gomti Nagar"}}', true)) ? 'ok', 'client submits');
select pg_temp.check(client_get(current_setting('t.tok')::uuid) #>> '{answers,e1,venue}' = 'Taj Gomti Nagar', 'answers come back');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, jsonb_build_object('x', repeat('a', 1600000)), false)) ? 'error', 'oversized answers refused');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((client_get(current_setting('t.tok')::uuid) ->> 'preview')::boolean, 'manager can preview the page');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, '{}', false)) ? 'error', 'but cannot fill it in for the family');
reset role;
update client_links set active = false;
set role authenticated; set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select pg_temp.check(client_get(current_setting('t.tok')::uuid) ? 'error' and jsonb_array_length(client_list()) = 0, 'switched-off page stops working');
set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check((select count(*) from client_itinerary)=0 and (select count(*) from client_links)=0, 'crew cannot see client answers or links');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select data #>> '{e1,venue}' from client_itinerary)='Taj Gomti Nagar' and (select submitted_at from client_itinerary) is not null, 'manager reads the submitted itinerary');
reset role;

-- ── attendance ──
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into employees (email, name, monthly_salary, start_time, weekly_off) values ('s@x.com','Staff One',30000,'10:00',0),('c@x.com','Hamza',20000,'10:00',2);
update att_settings set office_lat = 26.85, office_lng = 80.95, radius_m = 150;
reset role;
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.expect_fail($$select * from att_secret$$, 'employee reading the code secret');
select pg_temp.expect_fail($$select att_office_code()$$, 'employee showing the office code');
select pg_temp.check(att_punch('in', 26.86, 80.95, 10, null) ? 'error', 'check-in 1 km away refused');
select pg_temp.check(att_punch('in', 26.8501, 80.9501, 10, '000000') ? 'error', 'check-in with a wrong code refused');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"k@x.com"}';
select set_config('t.code', att_office_code() ->> 'code', false);
select pg_temp.check(length(current_setting('t.code')) = 6, 'office screen shows a 6-digit code');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check(att_punch('lunch_out', 26.8501, 80.9501, 10, current_setting('t.code')) ? 'error', 'lunch before check-in refused');
select pg_temp.check(att_punch('in', 26.8501, 80.9501, 10, current_setting('t.code')) ? 'ok', 'check-in at the office with the code');
select pg_temp.check(att_punch('in', 26.8501, 80.9501, 10, current_setting('t.code')) ? 'error', 'second check-in refused');
select pg_temp.check(att_punch('lunch_out', 26.8501, 80.9501, 10, current_setting('t.code')) ? 'ok', 'lunch out');
select pg_temp.expect_fail($$insert into att_punch (email, day, kind) values ('s@x.com', current_date, 'out')$$, 'employee writing a check-in directly');
select pg_temp.check((select count(*) from att_punch)=2, 'employee sees own check-ins');
reset role;
update att_settings set code_on = false;
set role authenticated; set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check(att_punch('in', 26.8501, 80.9501, 10, null) ? 'ok', 'with the code switched off, location alone is enough');
select pg_temp.check((select count(*) from att_punch)=1, 'crew employee sees only own check-ins');
update att_settings set code_on = true; -- under the rules this changes nothing
reset role;
select pg_temp.check((select code_on from att_settings)=false, 'employee cannot switch the code check');
select pg_temp.check((select count(*) from att_log where what like '%code check turned OFF%')=1, 'switching the code off is written down');
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check(att_punch('in', 26.8501, 80.9501, 10, null) ? 'error', 'manager who is not an employee cannot check in');
select pg_temp.check((select count(*) from att_punch)=0 and (select count(*) from employees)=0, 'manager does not see salaries or check-ins');
reset role;

-- requests and advances
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
insert into att_requests (email, kind, amount, per_month, reason, status) values ('o@x.com','advance',20000,5000,'family','approved');
select pg_temp.check((select email from att_requests)='s@x.com' and (select status from att_requests)='pending', 'request is signed as the employee and stays pending');
select pg_temp.expect_fail($$insert into att_requests (kind, amount) values ('advance', 15000)$$, 'advances above one month''s salary');
insert into att_requests (kind, day, fix_kind, fix_time, reason) values ('fix', current_date - 1, 'out', '19:05', 'phone died');
update att_requests set status = 'approved';
reset role;
select pg_temp.check((select count(*) from att_requests where status='approved')=0, 'employee cannot approve own request');
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
update att_requests set status = 'approved' where kind = 'fix';
reset role;
select pg_temp.check((select count(*) from att_punch where by_fix and kind='out' and email='s@x.com')=1, 'approved correction becomes a check-out');

-- payroll: accountant prepares, owner locks
set role authenticated; set request.jwt.claims = '{"email":"acc@x.com"}';
select pg_temp.check((select count(*) from employees)=2 and (select count(*) from att_punch)>=3, 'accountant sees all employees and check-ins');
insert into payroll_runs (month, data) values ('2026-10', '{"rows":[]}');
select pg_temp.expect_fail($$update payroll_runs set status='locked' where month='2026-10'$$, 'accountant locking the month');
update att_requests set status='declined'; -- changes nothing under the rules
select pg_temp.check((select count(*) from att_requests where status='declined')=0, 'accountant cannot decide requests');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
update payroll_runs set status='locked' where month='2026-10';
select pg_temp.expect_fail($$update payroll_runs set data='{}' where month='2026-10'$$, 'changing a locked month');
select pg_temp.expect_fail($$insert into holidays (day, name) values ('2026-10-20','Diwali')$$, 'holiday in a locked month');
insert into holidays (day, name, ask_in) values (public.today_ist(), 'Test holiday', '{c@x.com}');
insert into payslips (month, email, data) values ('2026-10','s@x.com','{"net":30000}'),('2026-10','c@x.com','{"net":20000}');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((select count(*) from payslips)=1 and (select data->>'net' from payslips)='30000', 'employee sees only own payslip');
select pg_temp.check((select count(*) from holidays)=1, 'employees see holidays');
reset role;
delete from att_punch where email='s@x.com' and day = public.today_ist();
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check(att_punch('in', 26.8501, 80.9501, 10, null) ->> 'flag' = 'holiday_unasked', 'coming in on a holiday without being asked is flagged');
reset role;
select 'ALL STUDIO CHECKS PASSED';

-- Access-rule test for supabase/007_work_desk.sql (after pg_stub, schema, 002, 003, 004, 005, 007).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('acc@x.com','accountant',null,'Acc',now()),
  ('hamza@x.com','crew','hamza','Hamza',now()),('saif@x.com','crew','saif','Saif',now()),('k@x.com','kiosk',null,'Office',now()) on conflict do nothing;
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;

-- ── people ──
select pg_temp.check((select count(*) from people) = 22 and (select code from people where name = 'Shrey') = 'M001' and (select code from people where name = 'Sandeep') = 'M022', 'first names are in, with codes M001…');
select pg_temp.check((select title from people where name = 'Imran') = 'Photo/Album Designer', 'job titles come from the salary list');
update people set email = 'hamza@x.com' where name = 'Hamza';
update people set email = 'saif@x.com' where name = 'Saif';
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.expect_fail($$insert into people (name, email) values ('X', 'BAD@X.COM')$$, 'Gmail not in lower case');
insert into people (name, email) values (' New Editor ', 'new@x.com');
select pg_temp.check((select code from people where email = 'new@x.com') = 'M023' and (select name from people where email = 'new@x.com') = 'New Editor', 'partner adds a person: next code, name tidied');
select pg_temp.expect_fail($$update people set code = 'M999' where email = 'new@x.com'$$, 'changing an employee code');
select pg_temp.expect_fail($$insert into people (name, code) values ('Y', 'bad')$$, 'a made-up code');
delete from people where email = 'new@x.com';
select pg_temp.check((select count(*) from people where email = 'new@x.com') = 1, 'partner cannot delete a person (only the owner)');
set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.check((select count(*) from people) = 1 and (select name from people) = 'Hamza', 'an editor sees only their own person row');
insert into people_private (person, upi, address, id_type, id_last4) values ((select id from people where name = 'Hamza'), 'hamza@upi', 'Lucknow', 'Aadhaar', '1234');
select pg_temp.expect_fail($$update people_private set id_last4 = '123456789012' where person = public.my_person()$$, 'a full ID number');
select pg_temp.expect_fail($$insert into people_private (person, upi) values ((select id from people where name = 'Saif'), 'x')$$, 'filling someone else''s details');
update people set title = 'Boss' where name = 'Hamza';
reset role;
select pg_temp.check((select title from people where name = 'Hamza') is distinct from 'Boss', 'an editor cannot change the register');
set role authenticated; set request.jwt.claims = '{"email":"acc@x.com"}';
select pg_temp.check((select upi from people_private) = 'hamza@upi' and (select count(*) from people) = 23, 'the accountant sees people and UPI');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from people_private) = 0, 'the partner does not see UPI or address');
reset role;

-- ── jobs ──
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into work_jobs (wedding_key, wedding_title, wedding_date, kind, fn_label, assignee, due)
values ('w:jyoti amit', 'Jyoti & Amit', '2026-10-05', 'reel', 'Haldi', (select id from people where name = 'Hamza'), '2026-11-10'),
       ('w:jyoti amit', 'Jyoti & Amit', '2026-10-05', 'trailer', 'Wedding', (select id from people where name = 'Saif'), '2026-11-20'),
       ('w:jyoti amit', 'Jyoti & Amit', '2026-10-05', 'lr', 'Mehndi', (select id from people where name = 'Hamza'), null);
select pg_temp.check((select created_by from work_jobs limit 1) = 'm@x.com', 'jobs remember who made them');
set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.check((select count(*) from work_jobs) = 2, 'an editor sees only their own jobs');
update work_jobs set status = 'editing', progress = 40, drive = 'M 5', link = 'https://drive.google.com/x' where kind = 'reel';
select pg_temp.check((select status from work_jobs where kind = 'reel') = 'editing' and (select started_at from work_jobs where kind = 'reel') is not null, 'editor starts a job (start time noted)');
select pg_temp.expect_fail($$update work_jobs set due = '2026-12-31' where kind = 'reel'$$, 'editor moving their due date');
select pg_temp.expect_fail($$update work_jobs set assignee = (select id from people where name = 'Saif') where kind = 'reel'$$, 'editor handing a job to someone else');
select pg_temp.expect_fail($$update work_jobs set status = 'final' where kind = 'reel'$$, 'editor marking a job final');
select pg_temp.expect_fail($$update work_jobs set status = 'sent' where kind = 'reel'$$, 'editor marking a job sent');
update work_jobs set status = 'rendered' where kind = 'reel';
select pg_temp.check((select progress from work_jobs where kind = 'reel') = 100, 'rendered video = 100%');
select pg_temp.expect_fail($$update work_jobs set count_total = 900 where kind = 'lr'$$, 'editor setting the photo total');
update work_jobs set count_done = 350 where kind = 'lr';
select pg_temp.expect_fail($$insert into work_jobs (wedding_key, wedding_title, kind) values ('x', 'X', 'reel')$$, 'editor creating a job');
delete from work_jobs;
select pg_temp.check((select count(*) from work_jobs) = 2, 'editor cannot delete jobs');
set request.jwt.claims = '{"email":"saif@x.com"}';
update work_jobs set progress = 99 where kind = 'reel';
reset role;
select pg_temp.check((select progress from work_jobs where kind = 'reel') = 100 and (select count_done from work_jobs where kind = 'lr') = 350, 'another editor cannot touch Hamza''s job');
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
update work_jobs set status = 'sent' where kind = 'reel';
update work_jobs set status = 'changes' where kind = 'reel';
select pg_temp.check((select round from work_jobs where kind = 'reel') = 2, 'client asked for changes: round 2 of the same job');
set request.jwt.claims = '{"email":"hamza@x.com"}';
update work_jobs set status = 'editing' where kind = 'reel';
update work_jobs set status = 'rendered' where kind = 'reel';
set request.jwt.claims = '{"email":"m@x.com"}';
update work_jobs set status = 'final' where kind = 'reel';
select pg_temp.check((select done_at from work_jobs where kind = 'reel') is not null and (select round from work_jobs where kind = 'reel') = 2, 'partner marks it final (finish time noted)');
set request.jwt.claims = '{"email":"k@x.com"}';
select pg_temp.check((select count(*) from work_jobs) = 0 and (select count(*) from people) = 0, 'the office screen sees no jobs or people');
reset role;
set role anon; set request.jwt.claims = '{}';
select pg_temp.expect_fail($$select * from work_jobs$$, 'visitor reading jobs');
select pg_temp.expect_fail($$select * from people$$, 'visitor reading people');
reset role;

-- ── daily reports ──
set role authenticated; set request.jwt.claims = '{"email":"hamza@x.com"}';
insert into work_reports (person, job, progress, hours, note) values (public.my_person(), (select id from work_jobs where kind = 'lr'), null, 6, 'Mehndi LR 350 photos');
insert into work_reports (person, note, hours) values (public.my_person(), 'Data copy from cards to M 5', 2);
select pg_temp.check((select count(*) from work_reports) = 2 and (select by_email from work_reports limit 1) = 'hamza@x.com', 'editor writes today''s report');
select pg_temp.expect_fail($$insert into work_reports (person, note) values (public.my_person(), '  ')$$, 'an empty report line');
reset role;
select set_config('t.trailer', (select id::text from work_jobs where kind = 'trailer'), false);
set role authenticated; set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.expect_fail($$insert into work_reports (person, job) values (public.my_person(), current_setting('t.trailer')::uuid)$$, 'reporting on someone else''s job');
select pg_temp.expect_fail($$insert into work_reports (person, note, day) values (public.my_person(), 'old', current_date - 5)$$, 'a report for last week');
select pg_temp.expect_fail($$update work_reports set hours = 10$$, 'changing a sent report');
set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((select count(*) from work_reports) = 0, 'colleagues cannot read each other''s reports');
select pg_temp.expect_fail($$insert into work_reports (person, note) values ((select p.id from people p where p.name = 'Hamza'), 'fake')$$, 'writing a report for someone else');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from work_reports) = 2, 'partner reads every report');
set request.jwt.claims = '{"email":"hamza@x.com"}';
delete from work_reports where note like 'Data copy%';
select pg_temp.check((select count(*) from work_reports) = 1, 'editor can take back a line the same day');
reset role;
select 'ALL WORK DESK CHECKS PASSED';

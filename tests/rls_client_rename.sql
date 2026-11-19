-- Test for supabase/031_client_rename.sql (after pg_stub, schema and every file up to 030, then 031).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('hamza@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
update people set email = 'hamza@x.com' where name = 'Hamza';
insert into people (name, email) values ('Ravi', 'o@x.com'), ('Manager', 'm@x.com');
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
set request.jwt.claims = '{"email":"o@x.com"}';
-- the client "Shrama" (typed wrong) with everything hanging on it, and another client "Verma" with its own login and package
insert into client_links (wedding_key, title, emails) values ('w:shrama', 'Shrama', '{fam@gmail.com}'), ('w:verma', 'Verma', '{v@gmail.com}');
insert into client_feed (wedding_key, data) values ('w:shrama', '{"functions":[]}');
insert into client_itinerary (wedding_key, data) values ('w:shrama', '{"answers":{"x":1}}');
insert into bookings (wedding_key, title, package_name, items, total, plan, grace_days) values ('w:shrama', 'Shrama', 'Gold', '[]', 100000, '[]', 3), ('w:verma', 'Verma', 'Gold', '[]', 50000, '[]', 3);
insert into booking_payments (wedding_key, amount, mode) values ('w:shrama', 40000, 'UPI');
insert into work_jobs (wedding_key, wedding_title, wedding_date, kind, fn_label, assignee, due) values ('w:shrama', 'Shrama', '2026-12-01', 'reel', 'Haldi', (select id from people where name = 'Hamza'), '2026-12-20');
insert into drives (name, kind) values ('M 6', 'SSD');
insert into drive_items (drive, wedding_key, title, what, path) values ((select id from drives where name = 'M 6'), 'w:shrama', 'Shrama · Haldi', 'raw', 'Shrama/Haldi');
set role authenticated; set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.check((client_rename('w:shrama', 'w:sharma', 'Sharma', array['e1','e2'])) ? 'error', 'crew cannot rename a client');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((client_rename('w:shrama', 'w:verma', 'Verma', array['e1'])) ->> 'error' like '%already has its own family login%', 'renaming onto another client with its own family login is refused');
reset role;
select pg_temp.check((select count(*) from client_links where wedding_key = 'w:shrama') = 1, '… and nothing moved');
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select set_config('t.r', client_rename('w:shrama', 'w:sharma', 'Sharma', array['e1','e2'])::text, false);
select pg_temp.check((current_setting('t.r')::jsonb -> 'moved' ->> 'jobs') = '1' and (current_setting('t.r')::jsonb -> 'moved' ->> 'drive_lines') = '1', 'renamed Shrama → Sharma: ' || (current_setting('t.r')::jsonb ->> 'moved'));
reset role;
select pg_temp.check((select title from client_links where wedding_key = 'w:sharma') = 'Sharma' and (select emails from client_links where wedding_key = 'w:sharma') = '{fam@gmail.com}', 'the family login moved (same Gmail, new name)');
select pg_temp.check(exists (select 1 from client_feed where wedding_key = 'w:sharma') and (select data -> 'answers' ->> 'x' from client_itinerary where wedding_key = 'w:sharma') = '1', 'their page and the answers they filled in moved');
select pg_temp.check(exists (select 1 from bookings where wedding_key = 'w:sharma') and (select sum(amount) from booking_payments where wedding_key = 'w:sharma') = 40000, 'package and payments moved');
select pg_temp.check((select wedding_title from work_jobs where wedding_key = 'w:sharma') = 'Sharma', 'the Work desk job moved and shows the new name');
select pg_temp.check(exists (select 1 from drive_items where wedding_key = 'w:sharma'), 'drive data moved');
select pg_temp.check(not exists (select 1 from client_links where wedding_key = 'w:shrama') and not exists (select 1 from bookings where wedding_key = 'w:shrama') and not exists (select 1 from work_jobs where wedding_key = 'w:shrama') and not exists (select 1 from drive_items where wedding_key = 'w:shrama'), 'nothing left under the old name');
select pg_temp.check((select count(*) from client_log where kind = 'rename' and event_id in ('e1','e2') and what like 'Client renamed to Sharma by %') = 2, 'one History line per shoot');
select pg_temp.check((select count(*) from drive_log where what like '%renamed%') = 0, 'the drive history is not filled with rename lines');

-- Test for supabase/030_drive_move_folders.sql (after pg_stub, schema and every file up to 029, then 030).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('shrey@x.com','crew','shrey','Shrey',now()) on conflict do nothing;
update people set email = 'shrey@x.com' where name = 'Shrey';
insert into people (name, email) values ('Ravi', 'o@x.com'), ('Manager', 'm@x.com');
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into drives (name, kind, size_label) values ('M 6', 'SSD', '2 TB'), ('Dibba 2', 'HDD', '4 TB');
insert into drive_items (drive, title, what, path) values
  ((select id from drives where name = 'M 6'), 'Sharma · Haldi A', 'raw', 'Shrama/Haldi'),
  ((select id from drives where name = 'M 6'), 'Sharma · Haldi B', 'raw', 'Shrama/Haldi/Candid'),
  ((select id from drives where name = 'M 6'), 'Verma · Mehndi', 'raw', 'Verma'),
  ((select id from drives where name = 'Dibba 2'), 'Other', 'raw', 'Shrama');
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((drive_set_paths((select id from drives where name = 'M 6'), (select jsonb_agg(jsonb_build_object('id', id, 'path', 'X')) from drive_items where path like 'Shrama%' and title like 'Sharma%'), 'x')) ? 'error', 'someone without the drive cannot move its folders');
set request.jwt.claims = '{"email":"m@x.com"}';
-- rename Shrama → Sharma and move it with Verma into 2026 (what the page sends: every line with its new folder)
select set_config('t.r', drive_set_paths((select id from drives where name = 'M 6'),
  (select jsonb_agg(jsonb_build_object('id', id, 'path', case when path like 'Shrama%' then '2026/Sharma' || substr(path, 7) else '2026/' || path end)) from drive_items where drive = (select id from drives where name = 'M 6')),
  'Moved Shrama (renamed Sharma), Verma to 2026')::text, false);
select pg_temp.check((current_setting('t.r')::jsonb ->> 'moved') = '3', 'three lines moved in one go');
select pg_temp.check((select string_agg(path, ',' order by title) from drive_items where drive = (select id from drives where name = 'M 6')) = '2026/Sharma/Haldi,2026/Sharma/Haldi/Candid,2026/Verma', 'folders keep their subfolders: 2026/Sharma/Haldi, …/Candid, 2026/Verma');
select pg_temp.check((select path from drive_items where title = 'Other') = 'Shrama', 'another drive is never touched');
select pg_temp.check(exists (select 1 from drive_log where drive = (select id from drives where name = 'M 6') and what like 'Moved Shrama (renamed Sharma), Verma to 2026 (3 items,%'), 'one line in the drive history');
select pg_temp.check((drive_set_paths((select id from drives where name = 'M 6'), jsonb_build_array(jsonb_build_object('id', (select id from drive_items where title = 'Other'), 'path', 'Y')), 'x')) ? 'error', 'a line from another drive is refused');
select pg_temp.check((drive_set_paths((select id from drives where name = 'M 6'), (select jsonb_agg(jsonb_build_object('id', id, 'path', case when title like 'Verma%' then '' else 'Z' end)) from drive_items where drive = (select id from drives where name = 'M 6')), 'x')) ? 'error'
  and (select count(*) from drive_items where path = 'Z') = 0, 'all or nothing: one line without a folder → nothing moves');

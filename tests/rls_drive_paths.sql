-- Test for supabase/029_drive_paths.sql (after pg_stub, schema and every file up to 028, then 029).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('shrey@x.com','crew','shrey','Shrey',now()) on conflict do nothing;
update people set email = 'shrey@x.com' where name = 'Shrey';
insert into people (name, email) values ('Ravi', 'o@x.com'), ('Manager', 'm@x.com');
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into drives (name, kind, size_label) values ('M 5', 'SSD', '2 TB'), ('Dibba 2', 'HDD', '4 TB');
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into cards (code) values ('C01'), ('C02');
select card_give(array(select id from cards order by code), (select id from people where name = 'Shrey'));
set request.jwt.claims = '{"email":"shrey@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
select card_use(id, true, 'e1', 'Sharma Haldi', 'Sharma', 'photo', 'candid', null, null) from cards;
select card_give(array(select id from cards order by code), null);
set request.jwt.claims = '{"email":"m@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
select card_copy((select id from cards where code = 'C01'), (select id from drives where name = 'M 5'), ' Sharma // Haldi / Candid/ ', 812, '120 GB', '[{"title":"Sharma · Haldi (Photo candid)"},{"title":"Sharma · Haldi (Video cine)"}]');
select card_copy((select id from cards where code = 'C02'), (select id from drives where name = 'M 5'), 'Sharma/Haldi/Cine', 400, '60 GB', '[{"title":"Sharma · Haldi (Video cine)"}]');
select pg_temp.check((select count(*) from drive_items where path = 'Sharma/Haldi/Candid') = 2 and (select count(*) from drive_items where path = 'Sharma/Haldi/Cine') = 1, 'card copies put their lines in the folder typed when copying (tidied: "Sharma/Haldi/Candid")');
insert into drive_items (drive, title, what, path) values ((select id from drives where name = 'M 5'), 'Sharma · Haldi edit', 'project', '/Sharma/Projects/');
select pg_temp.check((select path from drive_items where title = 'Sharma · Haldi edit') = 'Sharma/Projects', 'a typed folder is tidied the same way');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((drive_backup_folder((select id from drives where name = 'M 5'), 'Sharma/Haldi', (select id from drives where name = 'Dibba 2'))) ? 'error', 'only the admin or manager backs up a folder');
set request.jwt.claims = '{"email":"m@x.com"}';
select set_config('t.r', drive_backup_folder((select id from drives where name = 'M 5'), 'Sharma/Haldi', (select id from drives where name = 'Dibba 2'))::text, false);
select pg_temp.check((current_setting('t.r')::jsonb ->> 'lines') = '3' and (current_setting('t.r')::jsonb ->> 'cards_copied') = '2', 'back up the folder Sharma/Haldi: its 3 lines (both subfolders) go to Dibba 2, not Sharma/Projects');
select pg_temp.check((select string_agg(data, ',' order by code) from cards) = 'copied,copied', 'both cards in it turn copied (green)');
select pg_temp.check((select count(*) from drive_items x join drives d on d.id = x.drive where d.name = 'Dibba 2' and x.path like 'Sharma/Haldi/%' and x.what = 'backup') = 3, 'Dibba 2 has the same folders');
select pg_temp.check((select string_agg(folder, ',' order by folder) from card_copies where backup) = 'Sharma/Haldi/Candid,Sharma/Haldi/Cine', 'the backup copies of the cards name the folder');
select set_config('t.r2', drive_backup_folder((select id from drives where name = 'M 5'), 'Sharma', (select id from drives where name = 'Dibba 2'))::text, false);
select pg_temp.check((current_setting('t.r2')::jsonb ->> 'lines') = '1' and (current_setting('t.r2')::jsonb ->> 'skipped') = '3', 'backing up the whole Sharma folder later only adds what is missing (the project)');
select pg_temp.check((drive_backup_folder((select id from drives where name = 'M 5'), 'Gupta', (select id from drives where name = 'Dibba 2'))) ? 'error', 'an empty folder says so');
insert into drives (name, kind) values ('Red', 'HDD');
select drive_move_item((select id from drive_items where title = 'Sharma · Haldi edit' and what = 'project'), (select id from drives where name = 'Red'), true);
select pg_temp.check((select path from drive_items x join drives d on d.id = x.drive where d.name = 'Red') = 'Sharma/Projects', 'copy / move keeps the folder');
reset role;

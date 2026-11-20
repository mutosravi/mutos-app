-- Test for supabase/034_drive_folders_to_drive.sql (after pg_stub, schema and every file up to 033, then 034).
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
select card_copy((select id from cards where code = 'C01'), (select id from drives where name = 'M 5'), 'Sharma/Haldi', 800, '100 GB', '[{"title":"Sharma · Haldi"}]');
select card_copy((select id from cards where code = 'C01'), (select id from drives where name = 'Dibba 2'), 'Sharma/Haldi', 800, '100 GB', '[{"title":"Sharma · Haldi"}]');
select card_copy((select id from cards where code = 'C02'), (select id from drives where name = 'M 5'), 'Sharma/Reel', 40, '5 GB', '[{"title":"Sharma · Reel"}]');
insert into drive_items (drive, title, what, path) values ((select id from drives where name = 'M 5'), 'Gupta · Mehndi', 'raw', 'Gupta'), ((select id from drives where name = 'Dibba 2'), 'Gupta · Mehndi', 'raw', 'Gupta');
insert into drives (name, kind, size_label) values ('M 6', 'SSD', '2 TB');
reset role; update drive_items set path = 'Old/Gupta' where title = 'Gupta · Mehndi' and drive = (select id from drives where name = 'M 5'); set role authenticated;
-- the page sends every line with its new folder: Sharma (Haldi + Reel) into 2026 on M 6
create or replace function pg_temp.mv(p text) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('id', id, 'path', p || '/' || path)) from drive_items where drive = (select id from drives where name = 'M 5') and path like 'Sharma%' and removed_at is null $$;
grant execute on function pg_temp.mv(text) to authenticated;
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((drive_folders_to_drive((select id from drives where name = 'M 5'), pg_temp.mv('2026'), (select id from drives where name = 'M 6'), false)) ? 'error', 'a team member who holds neither drive cannot move');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((drive_folders_to_drive((select id from drives where name = 'M 5'), pg_temp.mv('2026'), (select id from drives where name = 'M 5'), false)) ->> 'error' like '%same drive%', 'the same drive is refused');
select pg_temp.check((drive_folders_to_drive((select id from drives where name = 'M 5'), pg_temp.mv('2026') || jsonb_build_array(jsonb_build_object('id', (select id from drive_items where title = 'Gupta · Mehndi' and drive = (select id from drives where name = 'Dibba 2')), 'path', 'X')), (select id from drives where name = 'M 6'), false)) ? 'error', 'a line from another drive is refused');
-- copy (backup) to M 6
select set_config('t.c', drive_folders_to_drive((select id from drives where name = 'M 5'), pg_temp.mv('2026'), (select id from drives where name = 'M 6'), true)::text, false);
select pg_temp.check((current_setting('t.c')::jsonb ->> 'done') = '2' and (select string_agg(path || ':' || what, ',' order by path) from drive_items where drive = (select id from drives where name = 'M 6')) = '2026/Sharma/Haldi:backup,2026/Sharma/Reel:backup', 'copy: Haldi and Reel are on M 6 under 2026/Sharma as backups');
select pg_temp.check((select string_agg(code || ':' || data, ',' order by code) from cards) = 'C01:copied,C02:copied', 'C02 had one copy: now copied (backup card copy on M 6)');
select pg_temp.check((select count(*) from drive_items where drive = (select id from drives where name = 'M 5') and removed_at is null and path like 'Sharma%') = 2, 'copy leaves M 5 as it was');
select pg_temp.check((drive_folders_to_drive((select id from drives where name = 'M 5'), pg_temp.mv('2026'), (select id from drives where name = 'M 6'), true)) ->> 'error' like '%already on M 6%', 'copying again: already there');
select pg_temp.check(exists (select 1 from drive_log where drive = (select id from drives where name = 'M 5') and what like 'Copied Sharma to M 6 (2 items,%') and exists (select 1 from drive_log where drive = (select id from drives where name = 'M 6') and what like 'Sharma copied (backup) here from M 5 (2 items)'), 'one history line on each drive');
-- move the Old folder (Gupta) from M 5 to M 6 top
select set_config('t.m', drive_folders_to_drive((select id from drives where name = 'M 5'), (select jsonb_agg(jsonb_build_object('id', id, 'path', path)) from drive_items where drive = (select id from drives where name = 'M 5') and path like 'Old%' and removed_at is null), (select id from drives where name = 'M 6'), false)::text, false);
select pg_temp.check((current_setting('t.m')::jsonb ->> 'done') = '1' and exists (select 1 from drive_items where drive = (select id from drives where name = 'M 6') and path = 'Old/Gupta' and what = 'raw' and removed_at is null)
  and exists (select 1 from drive_items where drive = (select id from drives where name = 'M 5') and title = 'Gupta · Mehndi' and removed_why = 'moved' and moved_to is not null), 'move: Gupta is on M 6 in Old/Gupta (raw), on M 5 marked moved');
-- all or nothing: a broken path in the list → nothing moves
select pg_temp.check((drive_folders_to_drive((select id from drives where name = 'M 5'), (select jsonb_agg(jsonb_build_object('id', id, 'path', case when path like '%Reel' then '' else 'Z' end)) from drive_items where drive = (select id from drives where name = 'M 5') and path like 'Sharma%' and removed_at is null), (select id from drives where name = 'Dibba 2'), false)) ? 'error'
  and not exists (select 1 from drive_items where path = 'Z'), 'all or nothing');
-- the holder of the destination may move into it, but only the studio can record a copy
set request.jwt.claims = '{"email":"o@x.com"}';
select drive_set_holder((select id from drives where name = 'Dibba 2'), (select id from people where name = 'Shrey'), 'test');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((drive_folders_to_drive((select id from drives where name = 'M 5'), pg_temp.mv('In'), (select id from drives where name = 'Dibba 2'), true)) ->> 'error' like '%Only the admin or the manager%', 'the holder cannot record a copy');
select pg_temp.check((drive_folders_to_drive((select id from drives where name = 'M 5'), pg_temp.mv('In'), (select id from drives where name = 'Dibba 2'), false)) ->> 'done' = '2', 'but he can move Sharma onto his drive');
select pg_temp.check((select string_agg(code || ':' || data, ',' order by code) from cards) = 'C01:copied,C02:copied', 'moved lines still count: cards stay copied');

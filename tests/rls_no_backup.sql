-- Test for supabase/032_no_backup.sql (after pg_stub, schema and every file up to 031, then 032).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('shrey@x.com','crew','shrey','Shrey',now()) on conflict do nothing;
update people set email = 'shrey@x.com' where name = 'Shrey';
insert into people (name, email) values ('Ravi', 'o@x.com'), ('Manager', 'm@x.com');
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into drives (name, kind, size_label) values ('M 5', 'SSD', '2 TB'), ('Dibba 2', 'HDD', '4 TB');
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into cards (code) values ('C01'), ('C02'), ('C03');
select card_give(array(select id from cards order by code), (select id from people where name = 'Shrey'));
set request.jwt.claims = '{"email":"shrey@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
select card_use(id, true, 'e1', 'Sharma Haldi', 'Sharma', 'photo', 'candid', null, null) from cards;
select card_give(array(select id from cards order by code), null);
set request.jwt.claims = '{"email":"m@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
select card_copy((select id from cards where code = 'C01'), (select id from drives where name = 'M 5'), 'Sharma/Haldi', 800, '100 GB', '[{"title":"Sharma · Haldi"}]');
select card_copy((select id from cards where code = 'C02'), (select id from drives where name = 'M 5'), 'Sharma/Reel', 40, '5 GB', '[{"title":"Sharma · Reel"}]');
select pg_temp.check((select string_agg(code || ':' || data, ',' order by code) from cards) = 'C01:single,C02:single,C03:hold', 'C01 and C02 copied once (single), C03 still on hold');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((card_no_backup((select id from cards where code = 'C01'), 'test', false)) ? 'error', 'a team member cannot say no backup is needed');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((card_no_backup((select id from cards where code = 'C03'), '', false)) ->> 'error' like '%not copied anywhere yet%', 'a card on hold (not copied anywhere) cannot skip the copy');
select pg_temp.check((card_no_backup((select id from cards where code = 'C01'), 'client took the raw on a pen drive', false)) ->> 'data' = 'copied', 'C01: no backup needed → copied (green)');
select pg_temp.check(exists (select 1 from card_log where card = (select id from cards where code = 'C01') and what like 'No backup needed (client took the raw on a pen drive): marked copied%'), 'and its history says why and who');
-- removing and bringing back its drive line keeps the decision while one copy is listed
reset role;
select pg_temp.check((select no_backup_cycle from cards where code = 'C01') = (select cycle from cards where code = 'C01'), 'remembered for this round');
-- a folder that needs no backup: its cards follow, the drive shows it
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select set_config('t.r', drive_no_backup((select id from drive_items where title = 'Sharma · Reel'), 'reel only, edited already', true)::text, false);
select pg_temp.check(current_setting('t.r')::jsonb -> 'cards' = '["C02"]' and (select data from cards where code = 'C02') = 'empty', 'folder Sharma/Reel needs no backup, as free: C02 turns free');
select pg_temp.check((select no_backup from drive_items where title = 'Sharma · Reel') and (select no_backup_why from drive_items where title = 'Sharma · Reel') = 'reel only, edited already', 'the drive line says no backup needed, and why');
select pg_temp.check(exists (select 1 from drive_log where what like 'No backup needed for Sharma · Reel%'), 'drive history line');
-- undo for a folder: C01's folder
select drive_no_backup((select id from drive_items where title = 'Sharma · Haldi'), 'x', false);
select drive_need_backup((select id from drive_items where title = 'Sharma · Haldi'));
select pg_temp.check((select data from cards where code = 'C01') = 'single' and not (select no_backup from drive_items where title = 'Sharma · Haldi'), 'Backup needed again: C01 back to single (amber), the folder shows no backup');
-- a later real backup still works
select card_copy((select id from cards where code = 'C01'), (select id from drives where name = 'Dibba 2'), 'Sharma/Haldi', 800, '100 GB', '[{"title":"Sharma · Haldi"}]');
select pg_temp.check((select data from cards where code = 'C01') = 'copied', 'a real backup later: copied as usual');

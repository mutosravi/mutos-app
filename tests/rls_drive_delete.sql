-- Test for supabase/033_drive_delete_folders.sql (after pg_stub, schema and every file up to 032, then 033).
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
select pg_temp.check((select string_agg(code || ':' || data, ',' order by code) from cards) = 'C01:copied,C02:single', 'C01 on two drives (copied), C02 on M 5 only (single)');
create or replace function pg_temp.sharma() returns uuid[] language sql as $$ select array_agg(id) from drive_items where drive = (select id from drives where name = 'M 5') and path like 'Sharma%' and removed_at is null $$;
grant execute on function pg_temp.sharma() to authenticated;

-- someone who neither runs the studio nor holds the drive
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((drive_delete_lines((select id from drives where name = 'M 5'), pg_temp.sharma(), 'Space needed', true, false)) ? 'error', 'a team member who does not hold the drive cannot mark it');
-- the check says what would happen
set request.jwt.claims = '{"email":"m@x.com"}';
select set_config('t.c', drive_delete_lines((select id from drives where name = 'M 5'), pg_temp.sharma(), 'Space needed', true, false)::text, false);
select pg_temp.check((current_setting('t.c')::jsonb ->> 'count') = '2' and (select string_agg(x ->> 'title', ',') from jsonb_array_elements(current_setting('t.c')::jsonb -> 'last') x) = 'Sharma · Reel', 'check: 2 items; only "Sharma · Reel" is the last copy (Haldi is also on Dibba 2)');
select pg_temp.check((select string_agg((x ->> 'code') || ':' || (x ->> 'now') || '>' || (x ->> 'after'), ',') from jsonb_array_elements(current_setting('t.c')::jsonb -> 'cards') x) = 'C01:copied>single,C02:single>hold', 'check: C01 would go to single, C02 back on hold');
select pg_temp.check((select count(*) from drive_items where removed_at is not null) = 0, 'the check changes nothing');
select pg_temp.check((drive_delete_lines((select id from drives where name = 'M 5'), pg_temp.sharma(), 'Space needed', false, false)) ->> 'error' like '%only copy%', 'the last copy needs "I know this is the only copy"');
select pg_temp.check((select count(*) from drive_items where removed_at is not null) = 0, 'refused = nothing deleted (all or nothing)');
select pg_temp.check((drive_delete_lines((select id from drives where name = 'M 5'), pg_temp.sharma() || (select id from drive_items where drive = (select id from drives where name = 'Dibba 2') and title = 'Gupta · Mehndi'), 'x', true, false)) ->> 'error' like '%no longer on M 5%', 'a line from another drive is refused');
select set_config('t.d', drive_delete_lines((select id from drives where name = 'M 5'), pg_temp.sharma(), 'Space needed', false, true)::text, false);
select pg_temp.check((current_setting('t.d')::jsonb ->> 'deleted') = '2' and (select count(*) from drive_items where removed_at is not null and removed_why = 'Space needed') = 2, 'manager: the Sharma folder (2 items) marked deleted with the reason');
select pg_temp.check((select string_agg(code || ':' || data, ',' order by code) from cards) = 'C01:single,C02:hold', 'cards follow: C01 single (Dibba 2 left), C02 back ON HOLD');
select pg_temp.check(exists (select 1 from drive_log where drive = (select id from drives where name = 'M 5') and what like 'Deleted from the drive (Space needed): Sharma/Haldi, Sharma/Reel (2 items, 1 of them the only copy,%'), 'one line in the drive history');
-- Gupta has a copy on Dibba 2: not a last copy
select pg_temp.check(jsonb_array_length(drive_delete_lines((select id from drives where name = 'M 5'), array(select id from drive_items where drive = (select id from drives where name = 'M 5') and title = 'Gupta · Mehndi'), 'x', true, false) -> 'last') = 0, 'a line with the same title on another drive is not the last copy');

-- whoever holds the drive may delete, but not a last copy
set request.jwt.claims = '{"email":"o@x.com"}';
select drive_set_holder((select id from drives where name = 'Dibba 2'), (select id from people where name = 'Shrey'), 'test');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((drive_delete_lines((select id from drives where name = 'Dibba 2'), array(select id from drive_items where drive = (select id from drives where name = 'Dibba 2') and title like 'Sharma%'), 'x', false, true)) ->> 'error' like '%Only the admin or a manager%', 'the holder cannot delete the only copy (Haldi is now only on Dibba 2)');
select pg_temp.check((drive_delete_lines((select id from drives where name = 'Dibba 2'), array(select id from drive_items where drive = (select id from drives where name = 'Dibba 2') and title like 'Gupta%'), 'Duplicate', false, false)) ->> 'deleted' = '1', 'but he can delete Gupta (still on M 5)');

-- bring back the Sharma folder
select pg_temp.check((drive_restore_lines((select id from drives where name = 'M 5'), array(select id from drive_items where removed_why = 'Space needed'), 'by mistake')) ? 'error', 'a team member cannot bring data back');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((drive_restore_lines((select id from drives where name = 'M 5'), array(select id from drive_items where removed_why = 'Space needed'), '')) ? 'error', 'a reason is required');
select pg_temp.check((drive_restore_lines((select id from drives where name = 'M 5'), array(select id from drive_items where removed_why = 'Space needed'), 'by mistake')) ->> 'restored' = '2', 'manager brings both back in one go');
select pg_temp.check((select string_agg(code || ':' || data, ',' order by code) from cards) = 'C01:copied,C02:single', 'cards go back up: C01 copied, C02 single');
select pg_temp.check(exists (select 1 from drive_log where what like 'Data brought back: Sharma/Haldi, Sharma/Reel (2 items,%by mistake)'), 'logged on the drive');

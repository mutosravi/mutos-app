-- Test for supabase/024_card_follows_drive.sql (after pg_stub, schema and every file up to 023, then 024).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('shrey@x.com','crew','shrey','Shrey',now()) on conflict do nothing;
update people set email = 'shrey@x.com' where name = 'Shrey';
insert into people (name, email) values ('Ravi', 'o@x.com'), ('Manager', 'm@x.com');
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into drives (name, kind) values ('M 5', 'SSD'), ('Dibba 2', 'HDD'), ('Red', 'HDD');
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into cards (code) values ('C01');
select set_config('t.c', (select id::text from cards where code = 'C01'), false), set_config('t.shrey', (select id::text from people where name = 'Shrey'), false);
select card_give(array[current_setting('t.c')::uuid], current_setting('t.shrey')::uuid);
set request.jwt.claims = '{"email":"shrey@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
select card_use(current_setting('t.c')::uuid, true, 'e1', 'Sharma Haldi', 'Sharma', 'photo', 'candid', null, null);
select card_give(array[current_setting('t.c')::uuid], null);
set request.jwt.claims = '{"email":"m@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
select card_copy(current_setting('t.c')::uuid, (select id from drives where name = 'M 5'), 'Sharma/Haldi', 812, null, '[{"title":"Sharma · Haldi"}]');
select card_copy(current_setting('t.c')::uuid, (select id from drives where name = 'Dibba 2'), 'Sharma/Haldi', 812, null, '[{"title":"Sharma · Haldi"}]');
select pg_temp.check((select data from cards where code = 'C01') = 'copied', 'C01 copied with a backup (green)');
-- the backup line is removed
update drive_items set removed_at = now(), removed_why = 'cleaned' where drive = (select id from drives where name = 'Dibba 2');
select pg_temp.check((select data from cards where code = 'C01') = 'single', 'backup line removed from Dibba 2 → C01 back to single copy');
select pg_temp.check(exists (select 1 from card_log where what = 'Line removed from Dibba 2: one copy left. Single copy again: backup needed.'), 'the card log says why');
-- the first copy line is removed too
update drive_items set removed_at = now(), removed_why = 'mistake' where drive = (select id from drives where name = 'M 5');
select pg_temp.check((select data from cards where code = 'C01') = 'hold' and (select data_since is not null from cards where code = 'C01'), 'no copy left → C01 ON HOLD (do not format)');
-- brought back (023)
select drive_item_restore((select id from drive_items where drive = (select id from drives where name = 'M 5')), 'removed by mistake');
select pg_temp.check((select data from cards where code = 'C01') = 'single', 'M 5 line brought back → single copy again');
select drive_item_restore((select id from drive_items where drive = (select id from drives where name = 'Dibba 2')), 'removed by mistake');
select pg_temp.check((select data from cards where code = 'C01') = 'copied', 'Dibba 2 line brought back → copied again');
-- moving a line to another drive is not a loss
select drive_move_item((select id from drive_items where drive = (select id from drives where name = 'Dibba 2') and removed_at is null), (select id from drives where name = 'Red'), false);
select pg_temp.check((select data from cards where code = 'C01') = 'copied', 'moving the backup to Red keeps C01 copied');
-- once the card is out again (new round), removing old lines does not touch it
select card_give(array[current_setting('t.c')::uuid], current_setting('t.shrey')::uuid);
set request.jwt.claims = '{"email":"shrey@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
set request.jwt.claims = '{"email":"m@x.com"}';
update drive_items set removed_at = now(), removed_why = 'cleaned' where drive = (select id from drives where name = 'M 5') and removed_at is null;
select pg_temp.check((select data || '/' || cycle from cards where code = 'C01') = 'empty/2', 'a card in its next round is not changed by old lines');
reset role;

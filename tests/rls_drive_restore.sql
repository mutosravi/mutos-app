-- Test for supabase/023_drive_restore.sql (after pg_stub, schema and every file up to 022, then 023).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('s@x.com','supervisor',null,'Sup',now()),('kuldeep@x.com','staff',null,'Kuldeep',now()) on conflict do nothing;
update people set email = 'kuldeep@x.com', skills = '{data}' where name = 'Kuldeep';
insert into people (name, email) values ('Ravi', 'o@x.com'), ('Manager', 'm@x.com');
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into drives (name, kind) values ('M 5', 'SSD'), ('Dibba 2', 'HDD');
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into drive_items (drive, title, what) values ((select id from drives where name = 'M 5'), 'Sharma · Haldi', 'raw'), ((select id from drives where name = 'M 5'), 'Gupta · Mehndi', 'raw');
-- removed by mistake
update drive_items set removed_at = now(), removed_why = 'cleaned' where title = 'Sharma · Haldi';
select pg_temp.check((select removed_at is not null from drive_items where title = 'Sharma · Haldi'), 'a line is removed (by mistake)');
do $$ begin begin update drive_items set removed_at = null where title = 'Sharma · Haldi'; raise exception 'FAIL editing it back by hand was allowed'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS editing it back by hand is refused (%)', sqlerrm; end; end $$;
set request.jwt.claims = '{"email":"kuldeep@x.com"}';
select pg_temp.check((drive_item_restore((select id from drive_items where title = 'Sharma · Haldi'), 'oops')) ? 'error', 'a drive keeper cannot bring it back');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((drive_item_restore((select id from drive_items where title = 'Sharma · Haldi'), 'oops')) ? 'error', 'the supervisor cannot either');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((drive_item_restore((select id from drive_items where title = 'Sharma · Haldi'), '')) ? 'error', 'a reason is needed');
select pg_temp.check(not ((drive_item_restore((select id from drive_items where title = 'Sharma · Haldi'), 'removed by mistake')) ? 'error'), 'the manager brings it back');
select pg_temp.check((select removed_at is null and removed_why is null from drive_items where title = 'Sharma · Haldi'), 'the same line is on the drive again (same id, history kept)');
select pg_temp.check(exists (select 1 from drive_log where what like 'Data brought back: Sharma · Haldi (raw) by Manager (manager) (removed by mistake; it was removed %"cleaned")'), 'the drive history says who brought it back, why, and when it had been removed');
select pg_temp.check((drive_item_restore((select id from drive_items where title = 'Sharma · Haldi'), 'again')) ? 'error', 'a line already on the drive: nothing to do');
-- a moved line is not brought back (the data is on the other drive)
select drive_move_item((select id from drive_items where title = 'Gupta · Mehndi'), (select id from drives where name = 'Dibba 2'), false);
select pg_temp.check((drive_item_restore((select id from drive_items where title = 'Gupta · Mehndi' and removed_at is not null), 'x')) ->> 'error' like 'This was moved to Dibba 2%', 'a moved line says where it went instead');
reset role;

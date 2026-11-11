-- Access-rule test for supabase/008_drives.sql (after pg_stub, schema, 002, 003, 004, 005, 007, 008).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),
  ('shrey@x.com','crew','shrey','Shrey',now()),('kuldeep@x.com','staff',null,'Kuldeep',now()),('saif@x.com','crew','saif','Saif',now()),('k@x.com','kiosk',null,'Office',now()) on conflict do nothing;
update people set email = 'shrey@x.com' where name = 'Shrey';
update people set email = 'kuldeep@x.com', skills = '{data}' where name = 'Kuldeep';
update people set email = 'saif@x.com' where name = 'Saif';
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;
select set_config('t.shrey', (select id::text from people where name = 'Shrey'), false), set_config('t.saif', (select id::text from people where name = 'Saif'), false),
       set_config('t.kul', (select id::text from people where name = 'Kuldeep'), false);

-- ── register (016: only the owner and manager add or change drives; the keeper only hands over) ──
set role authenticated; set request.jwt.claims = '{"email":"kuldeep@x.com"}';
select pg_temp.expect_fail($$insert into drives (name) values ('K1')$$, 'the drive keeper cannot add drives (016)');
set request.jwt.claims = '{"email":"m@x.com"}';
insert into drives (name, kind, size_label, model) values (' M 1 ', 'SSD', '2 TB', 'Crucial'), ('M 5', 'SSD', '2 TB', 'Crucial'), ('Red', 'HDD', '4 TB', 'WD Passport');
select pg_temp.check((select count(*) from drives) = 3 and (select name from drives where size_label = '2 TB' order by name limit 1) = 'M 1', 'the manager adds drives (names tidied)');
select pg_temp.expect_fail($$insert into drives (name) values ('m 1')$$, 'two drives with the same name');
select set_config('t.m1', (select id::text from drives where name = 'M 1'), false), set_config('t.m5', (select id::text from drives where name = 'M 5'), false), set_config('t.red', (select id::text from drives where name = 'Red'), false);
insert into drive_items (drive, wedding_key, title, what, size_label) values (current_setting('t.m1')::uuid, 'w:jyoti amit', 'Jyoti & Amit · Haldi', 'raw', '600 GB');
select set_config('t.item', (select id::text from drive_items limit 1), false);
select pg_temp.check((select added_by from drive_items) = 'm@x.com', 'data added, with who added it');
set request.jwt.claims = '{"email":"kuldeep@x.com"}';
update drives set size_label = '9 TB', notes = 'x' where name = 'M 5';
select pg_temp.check((select size_label from drives where name = 'M 5') = '2 TB', 'the drive keeper cannot change a drive''s details (016)');
select pg_temp.expect_fail($$insert into drive_items (drive, title) values (current_setting('t.m5')::uuid, 'x')$$, 'the drive keeper cannot list data on an office drive (016)');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.expect_fail($$update drives set holder = current_setting('t.shrey')::uuid where name = 'M 1'$$, 'handing a drive over by editing it');
set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((select count(*) from drives) = 3 and (select count(*) from drive_items) = 1, 'everyone at Muto''s can find a drive and what is on it');
select pg_temp.check((select count(*) from people_directory()) = 22, 'and sees the list of names to give a drive to');
select pg_temp.expect_fail($$insert into drives (name) values ('Mine')$$, 'an editor adding drives');
update drives set notes = 'x' where name = 'M 1';
select pg_temp.check((select notes from drives where name = 'M 1') is null, 'an editor cannot edit a drive they do not have') ;
select pg_temp.expect_fail($$insert into drive_items (drive, title) values (current_setting('t.m1')::uuid, 'x')$$, 'an editor adding data to a drive they do not have');
select pg_temp.check((drive_give(current_setting('t.m1')::uuid, current_setting('t.saif')::uuid)) ? 'error', 'an editor cannot give away a drive they do not have');
reset role;

-- ── give → accept (Kuldeep gives M 1 to Shrey) ──
set role authenticated; set request.jwt.claims = '{"email":"kuldeep@x.com"}';
select pg_temp.check((drive_give(current_setting('t.m1')::uuid, current_setting('t.shrey')::uuid, 'Jyoti project')) ? 'ok', 'Kuldeep gives M 1 to Shrey');
select pg_temp.check((select holder from drives where name = 'M 1') is null, 'until Shrey accepts, M 1 is still with the office');
set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((drive_answer((select id from drive_moves where status = 'pending'), true)) ? 'error', 'someone else cannot accept it');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((select count(*) from drive_moves where status = 'pending' and to_person = public.my_person()) = 1, 'Shrey sees it waiting for him');
select pg_temp.check((drive_answer((select id from drive_moves where status = 'pending'), true)) ? 'ok', 'Shrey accepts');
reset role;
select pg_temp.check((select holder from drives where name = 'M 1') = current_setting('t.shrey')::uuid, 'M 1 is now Shrey''s responsibility');
select pg_temp.check((select count(*) from drive_log where drive = current_setting('t.m1')::uuid and what like '%Shrey accepted M 1 from the office%') = 1, 'the history says so');
-- Shrey works on his drive, passes it to Saif, who declines; then gives it back to the office
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
insert into drive_items (drive, wedding_key, title, what) values (current_setting('t.m1')::uuid, 'w:jyoti amit', 'Jyoti & Amit · Reel', 'project');
select pg_temp.check((select count(*) from drive_items where drive = current_setting('t.m1')::uuid) = 2, 'whoever has the drive can add data on it');
select pg_temp.check((drive_give(current_setting('t.m1')::uuid, current_setting('t.shrey')::uuid)) ? 'error', 'giving a drive to yourself');
select pg_temp.check((drive_give(current_setting('t.m1')::uuid, current_setting('t.saif')::uuid)) ? 'ok', 'Shrey passes M 1 to Saif');
set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((drive_answer((select id from drive_moves where status = 'pending'), false)) ? 'ok', 'Saif declines');
reset role;
select pg_temp.check((select holder from drives where name = 'M 1') = current_setting('t.shrey')::uuid, 'a declined drive stays with Shrey');
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((drive_give(current_setting('t.m1')::uuid, null, 'done')) ? 'ok', 'Shrey returns M 1 to the office');
select pg_temp.check((drive_answer((select id from drive_moves where status = 'pending'), true)) ? 'error', 'the giver cannot accept their own return');
select pg_temp.check((drive_give(current_setting('t.m1')::uuid, current_setting('t.saif')::uuid)) ? 'ok', 'giving again replaces the waiting handover');
select pg_temp.check((select count(*) from drive_moves where status = 'pending') = 1 and (select count(*) from drive_moves where status = 'cancelled') = 1, 'only one handover waits at a time');
select pg_temp.check((drive_cancel((select id from drive_moves where status = 'pending'))) ? 'ok', 'the giver can take it back');
select pg_temp.check((drive_give(current_setting('t.m1')::uuid, null)) ? 'ok', 'and return it to the office instead');
set request.jwt.claims = '{"email":"kuldeep@x.com"}';
select pg_temp.check((drive_answer((select id from drive_moves where status = 'pending'), true)) ? 'ok', 'a drive keeper accepts the return');
reset role;
select pg_temp.check((select holder from drives where name = 'M 1') is null, 'M 1 is back in the office');
-- the drive changed hands while a handover waited
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((drive_give(current_setting('t.red')::uuid, current_setting('t.saif')::uuid)) ? 'ok', 'the partner gives Red to Saif');
reset role;
select set_config('t.mv', (select id::text from drive_moves where status = 'pending'), false);
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((drive_set_holder(current_setting('t.red')::uuid, current_setting('t.shrey')::uuid, 'was with Shrey all along')) ? 'ok', 'the owner corrects where Red is');
set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((drive_answer(current_setting('t.mv')::uuid, true)) ? 'error', 'an old handover cannot be accepted after a correction');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((drive_set_holder(current_setting('t.red')::uuid, null, 'x')) ? 'error', 'only the owner corrects where a drive is');
reset role;

-- ── moving data ──
set role authenticated; set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((drive_move_item(current_setting('t.item')::uuid, current_setting('t.m5')::uuid, false)) ? 'error', 'an editor cannot move data between drives they do not have');
set request.jwt.claims = '{"email":"kuldeep@x.com"}';
select pg_temp.check((drive_move_item(current_setting('t.item')::uuid, current_setting('t.m5')::uuid, false)) ? 'error', 'the keeper cannot move data between office drives (016)');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((drive_move_item(current_setting('t.item')::uuid, current_setting('t.m5')::uuid, false)) ? 'ok', 'the manager moves Jyoti & Amit Haldi raw from M 1 to M 5');
select pg_temp.check((select count(*) from drive_items where wedding_key = 'w:jyoti amit' and what = 'raw' and removed_at is null) = 1
  and (select d.name from drive_items i join drives d on d.id = i.drive where i.wedding_key = 'w:jyoti amit' and i.what = 'raw' and i.removed_at is null) = 'M 5', 'the wedding now shows on M 5');
select pg_temp.check((select removed_why from drive_items where id = current_setting('t.item')::uuid) = 'moved' and (select moved_to from drive_items where id = current_setting('t.item')::uuid) is not null, 'the old line stays as history, pointing to the new place');
select pg_temp.check((drive_move_item((select id from drive_items where drive = current_setting('t.m5')::uuid and removed_at is null), current_setting('t.red')::uuid, true)) ? 'ok', 'copy as a backup to Red');
select pg_temp.check((select count(*) from drive_items where wedding_key = 'w:jyoti amit' and what = 'raw' and removed_at is null) = 2, 'two copies now');
select pg_temp.expect_fail($$update drive_items set removed_at = null where id = current_setting('t.item')::uuid$$, 'bringing back a removed line');
select pg_temp.expect_fail($$delete from drive_items$$, 'deleting data lines');
update drive_items set removed_at = now(), removed_why = 'cleaned' where drive = current_setting('t.red')::uuid and removed_at is null;
update drives set cleaned_on = current_date, free_label = '3.9 TB' where name = 'Red';
select pg_temp.check((select count(*) from drive_log where drive = current_setting('t.red')::uuid and (what like 'Data removed (cleaned)%' or what like 'Cleaned on%')) = 2, 'cleaning is logged');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"k@x.com"}';
select pg_temp.check((select count(*) from drives) = 0 and (select count(*) from people_directory()) = 0, 'the office screen sees no drives or names');
reset role;
set role anon; set request.jwt.claims = '{}';
select pg_temp.expect_fail($$select * from drives$$, 'visitor reading drives');
select pg_temp.expect_fail($$select drive_give(gen_random_uuid(), null)$$, 'visitor giving drives');
reset role;
select 'ALL DRIVE CHECKS PASSED';

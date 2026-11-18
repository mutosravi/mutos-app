-- Test for supabase/028_drive_folders.sql (after pg_stub, schema and every file up to 027, then 028).
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
-- both cards copied into ONE folder on M 5 (as the copy screen does: same title)
select card_copy((select id from cards where code = 'C01'), (select id from drives where name = 'M 5'), 'Sharma/Haldi', 812, '120 GB', '[{"title":"Sharma · Haldi"}]');
select card_copy((select id from cards where code = 'C02'), (select id from drives where name = 'M 5'), 'Sharma/Haldi', 400, '60 GB', '[{"title":"Sharma · Haldi (2)"}]');
select pg_temp.check((select string_agg(data, ',' order by code) from cards) = 'single,single', 'both cards: single copy (amber)');
reset role;
-- what 028's one-time fill does for folders made before it
update drive_items set files = null;
update public.drive_items i set files = cc.files from public.card_copies cc where i.files is null and cc.items = array[i.id];
select pg_temp.check((select files from drive_items where title = 'Sharma · Haldi') = 812, 'old card folders get their file count from the copy');
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((drive_backup_item((select id from drive_items where title = 'Sharma · Haldi'), (select id from drives where name = 'Dibba 2'))) ? 'error', 'only the admin or manager records a backup');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((drive_backup_item((select id from drive_items where title = 'Sharma · Haldi'), (select id from drives where name = 'M 5'))) ? 'error', 'not onto the same drive');
select set_config('t.r', drive_backup_item((select id from drive_items where title = 'Sharma · Haldi'), (select id from drives where name = 'Dibba 2'))::text, false);
select pg_temp.check((current_setting('t.r')::jsonb ->> 'cards_copied') = '1' and current_setting('t.r')::jsonb -> 'cards' = '["C01"]', 'backed up the folder of C01: one card done');
select pg_temp.check((select data from cards where code = 'C01') = 'copied' and (select data from cards where code = 'C02') = 'single', 'C01 turns copied (green) by itself; C02 (another folder) stays single');
select pg_temp.check(exists (select 1 from drive_items x join drives d on d.id = x.drive where d.name = 'Dibba 2' and x.title = 'Sharma · Haldi' and x.what = 'backup' and x.files = 812 and x.size_label = '120 GB' and x.from_item = (select id from drive_items where title = 'Sharma · Haldi' and what = 'raw')), 'Dibba 2 lists the backup folder (812 files, 120 GB), linked to the original');
select pg_temp.check(exists (select 1 from card_copies where card = (select id from cards where code = 'C01') and backup and drive_name = 'Dibba 2'), 'the card records its backup copy');
select pg_temp.check(exists (select 1 from card_log where card = (select id from cards where code = 'C01') and what like 'Backup copied to Dibba 2 / %' and what like '%(folder backed up from M 5)%'), 'and says so in its history (with the folder, 029 names its path)');
select pg_temp.check((drive_backup_item((select id from drive_items where title = 'Sharma · Haldi' and what = 'raw'), (select id from drives where name = 'Dibba 2'))) ? 'error', 'the same folder cannot be backed up twice to the same drive');
select pg_temp.check((drive_backup_item((select id from drive_items where title = 'Sharma · Haldi' and what = 'backup'), (select id from drives where name = 'M 5'))) ? 'error', '… nor the backup copied back onto the original drive');
-- removing the backup folder puts C01 back to one copy (024 still works with these lines)
reset role;
update drive_items set removed_at = now(), removed_why = 'cleaned' where what = 'backup' and title = 'Sharma · Haldi';
select pg_temp.check((select data from cards where code = 'C01') = 'single', 'backup folder removed → C01 back to single copy');

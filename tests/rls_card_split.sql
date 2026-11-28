-- Test for supabase/048_card_copy_split.sql (after pg_stub, schema and every file up to 047, then 048).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('shrey@x.com','crew','shrey','Shrey',now()) on conflict do nothing;
update people set email = 'shrey@x.com' where name = 'Shrey';
insert into people (name, email) values ('Manager', 'm@x.com');
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into drives (name, kind, size_label) values ('M 5', 'SSD', '2 TB'), ('Dibba 2', 'HDD', '4 TB');
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into cards (code) values ('C01'), ('C02');
select card_give(array(select id from cards order by code), (select id from people where name = 'Shrey'));
set request.jwt.claims = '{"email":"shrey@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
select card_use((select id from cards where code = 'C01'), true, 'e1', 'Sharma Haldi', 'Sharma', 'both', 'candid', null, null);
select card_use((select id from cards where code = 'C02'), true, 'e1', 'Sharma Haldi', 'Sharma', 'photo', 'candid', null, null);
select card_give(array(select id from cards order by code), null);
set request.jwt.claims = '{"email":"m@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
-- photos and videos of a "both" card
select pg_temp.check((card_copy((select id from cards where code = 'C01'), (select id from drives where name = 'M 5'), 'Sharma/Haldi', 0, '274 GB', '[{"title":"Sharma · Haldi"}]', '{"photos": 1240, "videos": 0, "photo_size": "64 GB", "video_size": "210 GB"}')) ->> 'error' like '%photos AND how many videos%', 'both card: a missing video count is refused');
select set_config('t.r', card_copy((select id from cards where code = 'C01'), (select id from drives where name = 'M 5'), 'Sharma/Haldi', 0, '274 GB', '[{"title":"Sharma · Haldi"}]', '{"photos": 1240, "videos": 86, "photo_size": "64 GB", "video_size": "210 GB"}')::text, false);
select pg_temp.check((current_setting('t.r')::jsonb ->> 'files')::int = 1326, 'copied: files = 1240 photos + 86 videos = 1326');
select pg_temp.check((select photos || '/' || videos || '/' || photo_size || '/' || video_size || '/' || files || '/' || size_label from card_copies where card = (select id from cards where code = 'C01')) = '1240/86/64 GB/210 GB/1326/274 GB', 'the copy keeps photos, videos, both sizes, the total and the total size');
select pg_temp.check((select note from drive_items where title = 'Sharma · Haldi') like '%1240 photos (64 GB) + 86 videos (210 GB)%', 'the drive line says photos and videos with their sizes');
select pg_temp.check(exists (select 1 from card_log where card = (select id from cards where code = 'C01') and what like 'Copied to M 5 / Sharma/Haldi (1240 photos (64 GB) + 86 videos (210 GB), 274 GB)%'), 'the card history says them too');
-- the old way (one number) still works, also positionally with six arguments
select card_copy((select id from cards where code = 'C02'), (select id from drives where name = 'M 5'), 'Sharma/Haldi2', 800, '100 GB', '[{"title":"Sharma · Haldi 2"}]');
select pg_temp.check((select files || '/' || coalesce(photos::text, '-') from card_copies where card = (select id from cards where code = 'C02')) = '800/-', 'a photo-only card: one number as before');
-- backup of the both card, split again
select card_copy((select id from cards where code = 'C01'), (select id from drives where name = 'Dibba 2'), 'Sharma/Haldi', 0, '274 GB', '[{"title":"Sharma · Haldi"}]', '{"photos": 1240, "videos": 86, "photo_size": "64 GB", "video_size": "210 GB"}');
select pg_temp.check((select data from cards where code = 'C01') = 'copied', 'backup with photos + videos: C01 copied (green)');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((card_copy((select id from cards where code = 'C02'), (select id from drives where name = 'Dibba 2'), 'x', 0, null, '[]', '{"photos":1,"videos":1}')) ->> 'error' like 'Only the admin%', 'a team member still cannot mark copies');

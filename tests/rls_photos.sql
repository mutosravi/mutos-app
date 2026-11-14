-- Test for supabase/026_photos.sql (after pg_stub, schema and every file up to 025, then 026).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('shrey@x.com','crew','shrey','Shrey',now()),
  ('c@x.com','crew','hamza','Hamza',now()),('g@x.com','gear',null,'Gear',now()) on conflict do nothing;
update people set email = 'shrey@x.com' where name = 'Shrey';
insert into people (name, email) values ('Ravi', 'o@x.com'), ('Manager', 'm@x.com');
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
-- ── card photos ──
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into cards (code) values ('C01'), ('C02');
select set_config('t.c1', (select id::text from cards where code = 'C01'), false), set_config('t.c2', (select id::text from cards where code = 'C02'), false);
set request.jwt.claims = '{"email":"shrey@x.com"}';
select set_config('t.u', (upload_begin('card', null, array[current_setting('t.c1')::uuid, current_setting('t.c2')::uuid], 'card', 'e1', 'IMG_1.jpg', 'image/jpeg', 2000000, 'both cards full') ->> 'id'), false);
select pg_temp.check(current_setting('t.u') <> '', 'someone on People starts a card photo');
select pg_temp.check((upload_begin('card', null, array[current_setting('t.c1')::uuid], 'card', null, 'x.pdf', 'application/pdf', 100, null)) ? 'error', 'only photos');
select pg_temp.check((upload_begin('card', null, array[current_setting('t.c1')::uuid], 'card', null, 'x.jpg', 'image/jpeg', 40000000, null)) ? 'error', 'not over 25 MB');
select pg_temp.check((select count(*) from uploads) = 0, 'a pending photo is not listed yet');
select pg_temp.check(not exists (select 1 from information_schema.role_table_grants where table_name = 'uploads' and grantee = 'authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')), 'nobody writes the table directly');
set request.jwt.claims = '{"email":"g@x.com"}';
select pg_temp.check((upload_begin('card', null, array[current_setting('t.c1')::uuid], 'card', null, 'x.jpg', 'image/jpeg', 100, null)) ? 'error', 'a login not on People cannot add card photos');
reset role;
-- the Worker (server key) records the Drive file
update uploads set drive_id = 'drv1', thumb_id = 'drv1t', status = 'ok' where id = current_setting('t.u')::uuid;
select pg_temp.check((select count(*) from card_log where what like 'Photo added by Shrey: both cards full') = 2, 'both cards get "Photo added" in their history');
select pg_temp.check((select cards from uploads) = array[current_setting('t.c1')::uuid, current_setting('t.c2')::uuid] and (select cycles from uploads) = array[1, 1], 'remembers the cards and their round');
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((select count(*) from uploads) = 1 and upload_check(current_setting('t.u')::uuid, true) ->> 'drive_id' = 'drv1t' and upload_check(current_setting('t.u')::uuid, false) ->> 'drive_id' = 'drv1', 'the admin sees it (small copy and full)');
set request.jwt.claims = '{"email":"g@x.com"}';
select pg_temp.check((select count(*) from uploads) = 0 and upload_check(current_setting('t.u')::uuid, false) ? 'error', 'a login not on People does not');
set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check((upload_remove(current_setting('t.u')::uuid)) ? 'error', 'someone else cannot remove it');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check(not ((upload_remove(current_setting('t.u')::uuid)) ? 'error'), 'the person who added it can remove it');
select pg_temp.check((select count(*) from uploads) = 0, 'then it is off the list');
reset role;
select pg_temp.check((select drive_id from uploads where id = current_setting('t.u')::uuid) = 'drv1', 'the file itself stays in the studio''s Drive');
-- ── family photos ──
insert into client_links (wedding_key, title, emails) values ('w:bansal', 'Bansal / Gupta', '{divya@gmail.com}'), ('w:other', 'Other', '{other@gmail.com}');
insert into client_feed (wedding_key, data) values ('w:bansal', '{"functions":[{"id":"e1","name":"Ring"},{"id":"e2","name":"Haldi"}]}');
select set_config('t.tok', (select token::text from client_links where wedding_key = 'w:bansal'), false);
set role authenticated; set request.jwt.claims = '{"email":"divya@gmail.com"}';
select set_config('t.v', (upload_begin('client', current_setting('t.tok'), null, 'vip', null, 'dadi.jpg', 'image/jpeg', 1800000, 'Dadi') ->> 'id'), false);
select pg_temp.check((upload_begin('client', current_setting('t.tok'), null, 'vip', null, 'x.jpg', 'image/jpeg', 100, null)) -> 'folder' = '["Families", "Bansal - Gupta"]'::jsonb, 'goes in the folder Families / <wedding> (no slash in the name)');
set request.jwt.claims = '{"email":"other@gmail.com"}';
select pg_temp.check((upload_begin('client', current_setting('t.tok'), null, 'ref', null, 'x.jpg', 'image/jpeg', 100, null)) ? 'error', 'another family cannot add photos to this wedding');
reset role;
update uploads set drive_id = 'drv2', status = 'ok' where id = current_setting('t.v')::uuid;
set role authenticated; set request.jwt.claims = '{"email":"divya@gmail.com"}';
select pg_temp.check(upload_check(current_setting('t.v')::uuid, true) ->> 'drive_id' = 'drv2', 'the family sees their photo (no small copy yet: the full one)');
set request.jwt.claims = '{"email":"other@gmail.com"}';
select pg_temp.check(upload_check(current_setting('t.v')::uuid, false) ? 'error', 'another family does not');
set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check(upload_check(current_setting('t.v')::uuid, false) ? 'error', 'crew not on this wedding do not');
reset role;
insert into crew_feed (person_key, name, data) values ('hamza', 'Hamza', '{"shoots":[{"id":"e2"}]}') on conflict (person_key) do update set data = excluded.data;
set role authenticated; set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check(upload_check(current_setting('t.v')::uuid, false) ->> 'drive_id' = 'drv2', 'crew on a function of the wedding do');
-- reference photos reach the crew of their function
set request.jwt.claims = '{"email":"divya@gmail.com"}';
select client_save(current_setting('t.tok')::uuid, jsonb_build_object('vip', jsonb_build_array(jsonb_build_object('name', 'Dadi', 'pid', current_setting('t.v'))),
  'refs', '[{"pid":"r1","note":"stage idea","fn":"e1"},{"pid":"r2","note":"colours","fn":""}]'::jsonb), false);
set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check(crew_vip('e2') #>> '{vip,0,pid}' = current_setting('t.v') and jsonb_array_length(crew_vip('e2') -> 'refs') = 1 and crew_vip('e2') #>> '{refs,0,pid}' = 'r2', 'crew on Haldi: the important person and only the references for all functions');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check(jsonb_array_length(crew_vip('e1') -> 'refs') = 2 and (select count(*) from uploads where kind = 'client') = 1, 'the studio sees all of them');
reset role;

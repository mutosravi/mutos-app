-- Test for supabase/040_team_photos.sql (after pg_stub, schema and all files up to 039 with 026, WITH 040).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Manager',now()),('s@x.com','supervisor',null,'Sup',now()),('shrey@x.com','crew','shrey','Shrey',now()),('aman@x.com','crew','aman','Aman',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into docs (collection, id, data) values ('shooters', 's1', '{"id":"s1","name":"Shrey","role":"Photo","phone":"9876543210"}'), ('shooters', 's2', '{"id":"s2","name":"Aman","role":"Video"}');
insert into people (name, email, crew_keys) values ('Shrey Verma', 'shrey@x.com', '{s1}');
insert into client_links (token, wedding_key, title, emails) values ('11111111-1111-1111-1111-111111111111', 'w:sharma', 'Sharma', '{fam@gmail.com}'), ('22222222-2222-2222-2222-222222222222', 'w:gupta', 'Gupta', '{gupta@gmail.com}');
insert into client_feed (wedding_key, data) values
  ('w:sharma', jsonb_build_object('functions', jsonb_build_array(jsonb_build_object('id','e1','name','Sharma Haldi','date', to_char((now() at time zone 'Asia/Kolkata')::date + 1, 'YYYY-MM-DD'),'slot','Morning')),
                                  'team', jsonb_build_object('e1', jsonb_build_array(jsonb_build_object('name','Shrey','role','Photo','phone','9876543210'))))),
  ('w:gupta', jsonb_build_object('functions', jsonb_build_array(jsonb_build_object('id','g1','name','Gupta Ring','date', to_char((now() at time zone 'Asia/Kolkata')::date + 9, 'YYYY-MM-DD'),'slot','Evening')),
                                  'team', jsonb_build_object('g1', jsonb_build_array(jsonb_build_object('name','Shrey','role','Photo','phone','9876543210')))));
-- Shrey adds his photo
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
select set_config('t.u', upload_begin('person', null, null, 'avatar', null, 'me.jpg', 'image/jpeg', 50000, null)::text, false);
select pg_temp.check((current_setting('t.u')::jsonb -> 'folder') = '["Team photos"]'::jsonb and current_setting('t.u')::jsonb ->> 'name' like 'Shrey Verma · %', 'Shrey''s photo goes to the Drive folder "Team photos"');
reset role;
update uploads set status = 'ok', drive_id = 'd1' where id = (current_setting('t.u')::jsonb ->> 'id')::uuid;
select pg_temp.check((select status from team_photos) = 'pending' and (select names from team_photos) @> array['shrey', 'shrey verma'], 'it waits for approval, with his board and People names');
set role authenticated;
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((my_team_photo()) ->> 'status' = 'pending' and (select count(*) from uploads where kind = 'person') = 1, 'he sees his own photo, "waiting"');
set request.jwt.claims = '{"email":"aman@x.com"}';
select pg_temp.check((select count(*) from uploads where kind = 'person') = 0 and jsonb_array_length(team_photo_map()) = 0, 'a teammate does not see it before approval');
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select pg_temp.check((select count(*) from uploads where kind = 'person') = 0 and (select x -> 'team' -> 0 ->> 'photo' from jsonb_array_elements(client_team('11111111-1111-1111-1111-111111111111') -> 'functions') x) is null, 'nor the family');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((team_photo_decide(1, true, null)) ? 'error', 'the supervisor cannot approve');
set request.jwt.claims = '{"email":"aman@x.com"}';
select pg_temp.check((upload_begin('person', null, null, 'avatar', null, 'x.jpg', 'image/jpeg', 50000, null)) ->> 'id' is not null, 'Aman (crew login only) can add his own photo too');
reset role; update uploads set status = 'ok' where by_email = 'aman@x.com'; set role authenticated;
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from team_photos where status = 'pending') = 2, 'the manager sees both waiting');
select pg_temp.check((team_photo_decide((select id from team_photos where by_email = 'shrey@x.com'), true, null)) ->> 'ok' = 'true', 'the manager approves Shrey''s');
select pg_temp.check((team_photo_decide((select id from team_photos where by_email = 'aman@x.com'), false, 'Face not clear')) ->> 'ok' = 'true', '… and rejects Aman''s with a reason');
set request.jwt.claims = '{"email":"aman@x.com"}';
select pg_temp.check((select count(*) from uploads where kind = 'person' and by_email = 'shrey@x.com') = 1 and jsonb_array_length(team_photo_map()) = 1, 'now the team sees Shrey''s photo');
select pg_temp.check((my_team_photo()) ->> 'why' = 'Face not clear', 'Aman sees why his was not approved');
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select pg_temp.check((select x -> 'team' -> 0 ->> 'photo' from jsonb_array_elements(client_team('11111111-1111-1111-1111-111111111111') -> 'functions') x) = current_setting('t.u')::jsonb ->> 'id'
  and (select count(*) from uploads where kind = 'person') = 1, 'the family whose function is tomorrow gets Shrey''s photo on "Your team"');
set request.jwt.claims = '{"email":"gupta@gmail.com"}';
select pg_temp.check((select count(*) from uploads where kind = 'person') = 0, 'a family whose function with him is 9 days away cannot see it yet');
-- a new photo replaces the old one once approved
set request.jwt.claims = '{"email":"shrey@x.com"}';
select set_config('t.u2', upload_begin('person', null, null, 'avatar', null, 'me2.jpg', 'image/jpeg', 50000, null)::text, false);
reset role; update uploads set status = 'ok' where id = (current_setting('t.u2')::jsonb ->> 'id')::uuid;
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((team_photo_decide((select id from team_photos where upload = (current_setting('t.u2')::jsonb ->> 'id')::uuid), true, null)) ->> 'ok' = 'true', 'admin approves his new photo');
select pg_temp.check((select string_agg(status, ',' order by id) from team_photos where by_email = 'shrey@x.com') = 'replaced,approved' and jsonb_array_length(team_photo_map()) = 1, 'the earlier one is replaced: one photo per person');
reset role;

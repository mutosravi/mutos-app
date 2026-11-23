-- Test for supabase/039_my_phone.sql (after pg_stub, schema and all files up to 038, WITH 039).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Manager',now()),('shrey@x.com','crew','shrey','Shrey',now()),('raju@x.com','crew','raju','Raju',now()),('nobody@x.com','staff',null,'Nobody',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into docs (collection, id, data) values
  ('shooters', 's1', '{"id":"s1","name":"Shrey","role":"Photo","phone":"9876543210"}'),
  ('shooters', 's2', '{"id":"s2","name":"Shrey","role":"Drone","phone":"9876543210"}'),
  ('shooters', 's3', '{"id":"s3","name":"Aman","role":"Video","phone":"9000000003"}'),
  ('assistants', 'a1', '{"id":"a1","name":"Raju","role":"Assistant","phone":""}');
insert into people (name, email, phone, crew_keys) values ('Shrey Verma', 'shrey@x.com', '9876543210', '{s1}');
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((my_phone()) ->> 'phone' = '9876543210', 'Shrey sees his number as the studio has it');
select pg_temp.check((my_phone_set('12345')) ->> 'error' like 'Type your 10-digit%', 'a wrong number is refused');
select pg_temp.check((my_phone_set('+91 99887-76655')) ->> 'ok' = 'true', 'Shrey changes his number (+91 and dashes are fine)');
reset role;
select pg_temp.check((select phone from people where email = 'shrey@x.com') = '9988776655', 'People has the new number');
select pg_temp.check((select data ->> 'phone' from docs where id = 's1') = '9988776655' and (select data ->> 'phone' from docs where id = 's2') = '9988776655', 'both of his board records (Photo and Drone) have it');
select pg_temp.check((select data ->> 'phone' from docs where id = 's3') = '9000000003', 'nobody else''s record changes');
select pg_temp.check((select count(*) from phone_changes where name = 'Shrey Verma' and old_phone = '9876543210' and new_phone = '9988776655' and seen_at is null) = 1, 'the change is logged for the admin (old → new)');
-- Raju: not on People, only a crew login whose board name is raju
set role authenticated; set request.jwt.claims = '{"email":"raju@x.com"}';
select pg_temp.check((my_phone_set('9123456780')) ->> 'ok' = 'true', 'Raju (crew login, not on People) can set his number');
reset role;
select pg_temp.check((select data ->> 'phone' from docs where id = 'a1') = '9123456780', 'his board record has it');
set role authenticated; set request.jwt.claims = '{"email":"nobody@x.com"}';
select pg_temp.check((my_phone_set('9123456781')) ? 'error', 'someone not on the team list cannot');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((select count(*) from phone_changes) = 0, 'the team cannot read the change log');
select pg_temp.check((phone_changes_seen(array[1::bigint])) ? 'error', 'the team cannot mark changes seen');
do $$ begin
  begin update people set name = 'Hacker' where email = 'shrey@x.com'; if found then raise exception 'FAIL changed own name'; end if; raise notice 'PASS cannot change his own name';
  exception when insufficient_privilege then raise notice 'PASS cannot change his own name'; end;
end $$;
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from phone_changes where seen_at is null) = 2, 'the manager sees both changes');
select pg_temp.check((phone_changes_seen(array(select id from phone_changes))) ->> 'ok' = 'true', 'marks them seen');
select pg_temp.check((select count(*) from phone_changes where seen_at is null) = 0, '… none left to see');
reset role;

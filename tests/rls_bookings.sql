-- Access-rule test for supabase/009_bookings.sql (after pg_stub, schema, 002–005, 007, 008, 009).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('acc@x.com','accountant',null,'Acc',now()),
  ('c@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;

select pg_temp.check((select count(*) from packages) = 2, 'two placeholder packages to start from');
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into client_links (wedding_key, title, emails) values ('w:akriti', 'Akriti & Rohan', '{akriti@gmail.com}');
insert into bookings (wedding_key, title, package_name, items, total, plan, grace_days) values ('w:akriti', 'Akriti & Rohan', 'Premium', '[{"kind":"reel","per":"function"}]', 300000,
  jsonb_build_array(jsonb_build_object('label', 'Advance', 'due', current_date - 30, 'amount', 100000), jsonb_build_object('label', 'Before the wedding', 'due', current_date - 5, 'amount', 150000), jsonb_build_object('label', 'On delivery', 'due', current_date + 60, 'amount', 50000)), 3);
insert into booking_payments (wedding_key, amount, mode) values ('w:akriti', 100000, 'Bank');
select pg_temp.check((select by_email from booking_payments) = 'm@x.com', 'the partner records the advance (with who recorded it)');
select pg_temp.check((booking_summary('w:akriti') ->> 'paid')::numeric = 100000 and (booking_summary('w:akriti') ->> 'pending')::numeric = 200000 and (booking_summary('w:akriti') ->> 'overdue')::numeric = 150000
  and booking_summary('w:akriti') ->> 'next_label' = 'Before the wedding', 'summary: paid 1L, pending 2L, 1.5L overdue; next = Before the wedding');
delete from booking_payments;
select pg_temp.check((select count(*) from booking_payments) = 1, 'the partner cannot delete a payment (only the owner)');
reset role;
select set_config('t.tok', (select token::text from client_links), false);
-- the family
set role authenticated; set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select pg_temp.check((client_get(current_setting('t.tok')::uuid)) #>> '{booking,package}' = 'Premium' and ((client_get(current_setting('t.tok')::uuid)) #>> '{booking,overdue}')::numeric = 150000, 'the family sees the package, payments and what is overdue');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, '{"e1":{"venue":"x"}}', false)) ? 'ok', 'overdue does not lock: the family can still change their details');
select pg_temp.expect_fail($$select * from bookings$$ || ' where 1/(select count(*) from bookings) = 1', 'the family reading bookings directly');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into booking_payments (wedding_key, amount, mode) values ('w:akriti', 150000, 'UPI');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select pg_temp.check(((client_get(current_setting('t.tok')::uuid)) #>> '{booking,overdue}')::numeric = 0, 'paid: nothing overdue');
select pg_temp.check((client_get(current_setting('t.tok')::uuid)) #>> '{booking,next_label}' = 'On delivery', 'next due shown: On delivery');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, jsonb_build_object('vip', repeat('a', 900000)), false)) ? 'ok', 'room for small photos of important people');
select pg_temp.check((client_save(current_setting('t.tok')::uuid, jsonb_build_object('vip', repeat('a', 1600000)), false)) ? 'error', 'but not unlimited');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
update bookings set plan = jsonb_build_array(jsonb_build_object('label', 'All', 'due', current_date - 30, 'amount', 300000));
reset role;
set role authenticated; set request.jwt.claims = '{"email":"akriti@gmail.com"}';
select pg_temp.check(((client_get(current_setting('t.tok')::uuid)) #>> '{booking,overdue}')::numeric = 50000 and (client_save(current_setting('t.tok')::uuid, '{"e1":{"venue":"Taj"}}', false)) ? 'ok', 'overdue shown, page stays open');
set request.jwt.claims = '{"email":"someone@gmail.com"}';
select pg_temp.check(booking_summary('w:akriti') is null, 'a stranger gets no money details');
set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check((select count(*) from bookings) = 0 and (select count(*) from booking_payments) = 0 and (select count(*) from packages) = 0 and booking_summary('w:akriti') is null, 'crew see no bookings, payments or prices');
select pg_temp.expect_fail($$insert into booking_payments (wedding_key, amount) values ('w:akriti', 1)$$, 'crew recording a payment');
set request.jwt.claims = '{"email":"acc@x.com"}';
select pg_temp.check((select count(*) from booking_payments) = 2, 'the accountant reads payments');
select pg_temp.expect_fail($$insert into booking_payments (wedding_key, amount) values ('w:akriti', 1)$$, 'the accountant recording a payment');
set request.jwt.claims = '{"email":"o@x.com"}';
delete from booking_payments where amount = 150000;
select pg_temp.check((select count(*) from booking_payments) = 1, 'the owner can delete a wrong payment');
reset role;
set role anon; set request.jwt.claims = '{}';
select pg_temp.expect_fail($$select * from bookings$$, 'visitor reading bookings');
reset role;
-- crew see the family's important people only for their own shoots
insert into client_feed (wedding_key, data) values ('w:akriti', '{"functions":[{"id":"e1","name":"Haldi"},{"id":"e2","name":"Wedding"}]}') on conflict (wedding_key) do update set data = excluded.data;
update client_itinerary set data = '{"vip":[{"name":"Dadi","rel":"Grandmother","photo":"data:image/jpeg;base64,xx"}],"contacts":[{"name":"Rohit","phone":"98","fn":"e2"},{"name":"Papa","phone":"97","fn":""}]}' where wedding_key = 'w:akriti';
insert into crew_feed (person_key, name, data) values ('hamza', 'Hamza', '{"shoots":[{"id":"e1"}]}') on conflict (person_key) do update set data = excluded.data;
set role authenticated; set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check(crew_vip('e1') #>> '{vip,0,name}' = 'Dadi' and jsonb_array_length(crew_vip('e1') -> 'contacts') = 1 and crew_vip('e1') #>> '{contacts,0,name}' = 'Papa', 'crew on the Haldi see Dadi and the contacts for all functions (not the Wedding-only one)');
select pg_temp.check(crew_vip('e2') ? 'error', 'but not for a shoot they are not on');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"someone@gmail.com"}';
select pg_temp.check(crew_vip('e1') ? 'error', 'strangers see nothing');
reset role;
select 'ALL BOOKING CHECKS PASSED';

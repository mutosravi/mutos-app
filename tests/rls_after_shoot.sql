-- Test for supabase/035_after_shoot.sql (after pg_stub, schema and every file up to 034, then 035).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('s@x.com','supervisor',null,'Sup',now()),('hamza@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into client_links (token, wedding_key, title, emails) values ('11111111-1111-1111-1111-111111111111', 'w:sharma', 'Sharma', '{fam@gmail.com}'),
  ('22222222-2222-2222-2222-222222222222', 'w:verma', 'Verma', '{v@gmail.com}');
insert into bookings (wedding_key, title, package_name, items, total, plan, grace_days) values ('w:sharma', 'Sharma', 'Gold', '[{"kind":"reel","per":"wedding"}]', 100000, '[]', 3);
insert into booking_payments (wedding_key, amount, mode) values ('w:sharma', 40000, 'UPI');

-- the admin ticks services
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into client_deliveries (wedding_key, kind, title, status, link) values ('w:sharma', 'reel', 'Reel', 'ready', 'https://drive.google.com/x'), ('w:sharma', null, 'Pendrive', 'waiting', null);
select pg_temp.check((select count(*) from client_deliveries) = 2 and (select updated_by from client_deliveries where title = 'Reel') = 'o@x.com', 'admin adds the services to deliver');
do $$ begin
  begin insert into client_deliveries (wedding_key, title, link) values ('w:sharma', 'Bad', 'javascript:alert(1)'); raise exception 'FAIL a non-web link is refused';
  exception when check_violation then raise notice 'PASS a link must start with http(s)://'; end;
end $$;
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((select count(*) from client_deliveries) = 2, 'the supervisor can read them');
do $$ begin
  update client_deliveries set status = 'delivered'; if found then raise exception 'FAIL supervisor changed a delivery'; end if; raise notice 'PASS the supervisor cannot change them';
end $$;
set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.check((select count(*) from client_deliveries) = 0 and (select count(*) from client_pay_claims) = 0, 'crew sees no deliveries and no payments');

-- the family: status yes, link no (40 % paid)
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select set_config('t.a', client_after('11111111-1111-1111-1111-111111111111')::text, false);
select pg_temp.check((current_setting('t.a')::jsonb ->> 'open') = 'false' and (current_setting('t.a')::jsonb ->> 'need') = '50000', 'family: closed at 40 % paid, ₹50,000 more opens it');
select pg_temp.check((select bool_and(d -> 'link' = 'null'::jsonb) from jsonb_array_elements(current_setting('t.a')::jsonb -> 'deliveries') d)
  and (select count(*) from jsonb_array_elements(current_setting('t.a')::jsonb -> 'deliveries') d where d ->> 'status' = 'ready' and (d ->> 'has_link')::boolean) = 1, 'family sees "Reel · Ready" but not the link');
select pg_temp.check((client_after('22222222-2222-2222-2222-222222222222')) ? 'error', 'a family cannot open another family''s page');
select pg_temp.check((client_pay_claim('22222222-2222-2222-2222-222222222222', 1000, current_date, 'UPI', 'x', null, null)) ? 'error', '… nor report a payment for them');
select pg_temp.check((client_pay_claim('11111111-1111-1111-1111-111111111111', 0, current_date, 'UPI', null, null, null)) ->> 'error' like 'Type the amount%', 'an amount is needed');
select pg_temp.check((client_pay_claim('11111111-1111-1111-1111-111111111111', 1000, current_date + 3, 'UPI', null, null, null)) ->> 'error' like 'Pick the date%', 'a date in the future is refused');
select set_config('t.c', client_pay_claim('11111111-1111-1111-1111-111111111111', 52000, current_date, 'UPI', '412345678901', 'from Rahul', null) ->> 'id', false);
select set_config('t.c2', client_pay_claim('11111111-1111-1111-1111-111111111111', 999, current_date, 'Cash', null, null, null) ->> 'id', false);
select pg_temp.check(current_setting('t.c') <> '' and (select count(*) from jsonb_array_elements(client_after('11111111-1111-1111-1111-111111111111') -> 'claims') x where x ->> 'status' = 'pending') = 2, 'family reports two payments: both "Muto''s is checking"');
do $$ begin
  begin insert into client_pay_claims (wedding_key, amount, paid_on, by_email) values ('w:sharma', 5, current_date, 'fam@gmail.com'); raise exception 'FAIL family inserted directly';
  exception when insufficient_privilege then raise notice 'PASS no direct writes to the payment reports'; end;
end $$;
select pg_temp.check((client_pay_decide(current_setting('t.c')::uuid, true, null, null)) ? 'error', 'the family cannot approve its own payment');

-- the manager approves one, rejects the other
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((client_pay_decide(current_setting('t.c')::uuid, true, null, null)) ? 'error', 'the supervisor cannot approve');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from client_pay_claims where status = 'pending') = 2, 'the manager sees the two to check');
select pg_temp.check((client_pay_decide(current_setting('t.c2')::uuid, false, '', null)) ->> 'error' like 'Write why%', 'not received needs a reason');
select pg_temp.check((client_pay_decide(current_setting('t.c2')::uuid, false, 'Not in our account', null)) ->> 'ok' = 'true', 'rejected with a reason');
select set_config('t.d', client_pay_decide(current_setting('t.c')::uuid, true, null, 50000)::text, false);
select pg_temp.check((current_setting('t.d')::jsonb ->> 'open') = 'true', 'approved ₹50,000 (they wrote 52,000): 90 % paid, deliveries open');
select pg_temp.check((select sum(amount) from booking_payments where wedding_key = 'w:sharma') = 90000 and exists (select 1 from booking_payments where note like 'Family reported · ref 412345678901 · from Rahul · they wrote 52000%'), 'it is now a payment in Package & payments, with the ref');
select pg_temp.check((client_pay_decide(current_setting('t.c')::uuid, false, 'again', null)) ->> 'error' like 'Already%', 'a decided payment cannot be decided again');

set request.jwt.claims = '{"email":"fam@gmail.com"}';
select set_config('t.a', client_after('11111111-1111-1111-1111-111111111111')::text, false);
select pg_temp.check((current_setting('t.a')::jsonb ->> 'open') = 'true' and (select d ->> 'link' from jsonb_array_elements(current_setting('t.a')::jsonb -> 'deliveries') d where d ->> 'title' = 'Reel') = 'https://drive.google.com/x', 'family: the Reel link is open now');
select pg_temp.check((select x ->> 'why' from jsonb_array_elements(current_setting('t.a')::jsonb -> 'claims') x where x ->> 'status' = 'rejected') = 'Not in our account', 'family sees why the cash one was not received');

-- by hand
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((client_deliveries_set_open('w:sharma', false)) ->> 'open' = 'false', 'manager keeps them closed by hand');
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select pg_temp.check((client_after('11111111-1111-1111-1111-111111111111')) ->> 'open' = 'false', '… and the family''s links are hidden again');
select pg_temp.check((client_deliveries_set_open('w:sharma', true)) ? 'error', 'the family cannot open them');
set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((client_deliveries_set_open('w:verma', true)) ->> 'open' = 'true', 'admin opens Verma by hand (no package)');
select pg_temp.check((client_deliveries_set_open('w:sharma', null)) ->> 'open' = 'true', 'back to the 90 % rule: open');
reset role;

-- rename moves them too (031 run again after 035)
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((client_rename('w:sharma', 'w:sharma-kapoor', 'Sharma Kapoor', array['e1'])) ->> 'ok' = 'true', 'rename Sharma');
reset role;
select pg_temp.check((select count(*) from client_deliveries where wedding_key = 'w:sharma-kapoor') = 2 and (select count(*) from client_pay_claims where wedding_key = 'w:sharma-kapoor') = 2, 'deliveries and payment reports move with a rename');

-- payment screenshots (with 026): the family adds one to Families/<name>/Payments; crew and the supervisor never see it
set role authenticated; set request.jwt.claims = '{"email":"v@gmail.com"}';
select set_config('t.u', upload_begin('client', '22222222-2222-2222-2222-222222222222', null, 'pay', null, 'pay.jpg', 'image/jpeg', 1000, 'Rs 5000')::text, false);
select pg_temp.check((current_setting('t.u')::jsonb -> 'folder') = '["Families", "Verma", "Payments"]'::jsonb and current_setting('t.u')::jsonb ->> 'name' like 'Payment · Rs 5000 · %', 'family screenshot goes to Families / Verma / Payments');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((upload_begin('client', '22222222-2222-2222-2222-222222222222', null, 'pay', null, 'pay.jpg', 'image/jpeg', 1000, null)) ? 'error', 'the studio does not add payment screenshots for a family');
reset role;
update uploads set status = 'ok' where id = (current_setting('t.u')::jsonb ->> 'id')::uuid;
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((select count(*) from uploads where purpose = 'pay') = 0, 'the supervisor cannot see a payment screenshot');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from uploads where purpose = 'pay') = 1, 'the manager can');
set request.jwt.claims = '{"email":"v@gmail.com"}';
select pg_temp.check((client_pay_claim('22222222-2222-2222-2222-222222222222', 5000, current_date, 'UPI', null, null, (current_setting('t.u')::jsonb ->> 'id')::uuid)) ->> 'error' like '%not added your package%', 'Verma has no package yet: Muto''s must add it first');
reset role;

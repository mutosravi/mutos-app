-- Test for supabase/043_deliveries_from_bills.sql (after pg_stub, schema and every file up to 042, then 043).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('s@x.com','supervisor',null,'Sup',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into client_links (token, wedding_key, title, emails) values ('11111111-1111-1111-1111-111111111111', 'w:sharma', 'Sharma', '{fam@gmail.com}'),
  ('22222222-2222-2222-2222-222222222222', 'w:verma', 'Verma', '{v@gmail.com}');
insert into bookings (wedding_key, title, package_name, items, total, plan) values ('w:verma', 'Verma', 'Gold', '[]', 100000, '[]');
insert into booking_payments (wedding_key, amount, mode) values ('w:verma', 50000, 'UPI');

set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into bank_accounts (name, opening, opening_on) values ('myBillBook (before the app)', 0, current_date - 400), ('HDFC Current', 100000, current_date - 10);
-- a myBillBook party, not linked to the board client yet, with a bill 95 % paid
insert into parties (name) values ('Mr Sharma (Akriti)');
insert into sales_docs (kind, party, lines) select 'invoice', id, '[{"name":"Wedding","qty":1,"rate":200000}]' from parties where name like 'Mr Sharma%';
insert into money_txns (kind, amount, account, party, alloc) select 'in', 190000, (select id from bank_accounts where name like 'myBillBook%'), p.id, jsonb_build_array(jsonb_build_object('doc', d.id, 'amount', 190000))
  from parties p join sales_docs d on d.party = p.id where p.name like 'Mr Sharma%';
select pg_temp.check(not (client_money('w:sharma') ->> 'open')::boolean, 'party not linked yet: deliveries closed (the rule cannot see the bill)');
select set_config('t.m', client_money('w:sharma')::text, false);
select pg_temp.check((current_setting('t.m')::jsonb ->> 'bills')::int = 0 and jsonb_array_length(current_setting('t.m')::jsonb -> 'parties') = 0, 'client_money: no bills, no party linked');
-- link the party to the board client (Sales desk → Parties → Link to board clients)
update parties set wedding_key = 'w:sharma' where name like 'Mr Sharma%';
select pg_temp.check((client_money('w:sharma') ->> 'open')::boolean, 'linked: the bill is 95 % paid in the Sales desk, deliveries open');
select set_config('t.m', client_money('w:sharma')::text, false);
select pg_temp.check(current_setting('t.m')::jsonb ->> 'source' = 'bills' and (current_setting('t.m')::jsonb ->> 'bills_total')::numeric = 200000 and (current_setting('t.m')::jsonb ->> 'bills_paid')::numeric = 190000, 'client_money: from the bills, 1,90,000 of 2,00,000');
-- the package rule still works on its own
select pg_temp.check(not (client_money('w:verma') ->> 'open')::boolean, 'Verma: package 50 % paid, no bills: closed');
reset role; insert into booking_payments (wedding_key, amount, mode) values ('w:verma', 40000, 'UPI'); set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((client_money('w:verma') ->> 'open')::boolean, 'Verma: package 90 % paid: open (as before)');
-- closed by hand wins over the bills
update client_links set deliveries_open = false where wedding_key = 'w:sharma';
select pg_temp.check(not (client_money('w:sharma') ->> 'open')::boolean, 'kept closed by hand wins over the paid bills');
update client_links set deliveries_open = null where wedding_key = 'w:sharma';
-- a cancelled bill does not count
insert into sales_docs (kind, party, lines) select 'invoice', id, '[{"name":"Album","qty":1,"rate":100000}]' from parties where name like 'Mr Sharma%';
select pg_temp.check(not (client_money('w:sharma') ->> 'open')::boolean, 'a new unpaid bill: 1,90,000 of 3,00,000 → closed again');
update sales_docs set status = 'cancelled', cancel_why = 'wrong' where lines @> '[{"name":"Album"}]';
select pg_temp.check((client_money('w:sharma') ->> 'open')::boolean, 'that bill cancelled: open again');
-- only the studio sees client_money
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((client_money('w:sharma')) ? 'error', 'the supervisor cannot read a client''s money');

-- the family page
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select set_config('t.a', client_after('11111111-1111-1111-1111-111111111111')::text, false);
select pg_temp.check((current_setting('t.a')::jsonb ->> 'open')::boolean and current_setting('t.a')::jsonb ->> 'source' = 'bills' and (current_setting('t.a')::jsonb ->> 'total')::numeric = 200000
  and (current_setting('t.a')::jsonb ->> 'can_claim')::boolean, 'family page: open, numbers from the bills, and "We paid" works without a package');
select set_config('t.c', client_pay_claim('11111111-1111-1111-1111-111111111111', 10000, current_date, 'UPI', '9999', null, null) ->> 'id', false);
select pg_temp.check(current_setting('t.c') <> '', 'family reports ₹10,000 (no package, has bills)');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((client_pay_decide(current_setting('t.c')::uuid, true, null, null)) ->> 'error' like '%pick the account%', 'no package: approving needs an account');
select set_config('t.r', client_pay_decide(current_setting('t.c')::uuid, true, null, null, (select id from bank_accounts where name = 'HDFC Current'))::text, false);
select pg_temp.check(current_setting('t.r')::jsonb ->> 'txn' like 'IN-%' and (select count(*) from booking_payments where wedding_key = 'w:sharma') = 0, 'approved into the Sales desk (IN-…), no package payment made');
select pg_temp.check((select paid from sales_docs where status <> 'cancelled' and party = (select id from parties where name like 'Mr Sharma%')) = 200000, 'the bill is now fully paid');
-- the 035/042 path with a package is unchanged
reset role; insert into client_pay_claims (wedding_key, amount, paid_on, mode, by_email) values ('w:verma', 5000, current_date, 'Cash', 'v@gmail.com'); set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((client_pay_decide((select id from client_pay_claims where wedding_key = 'w:verma'), true, null, null)) ->> 'ok' = 'true', 'Verma (package): approving without an account works as before');
select pg_temp.check((select count(*) from booking_payments where wedding_key = 'w:verma') = 3, '… and adds to the package');
reset role;

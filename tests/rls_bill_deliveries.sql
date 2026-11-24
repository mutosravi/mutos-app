-- Test for supabase/042_bill_deliveries.sql (after pg_stub, schema and every file up to 041, then 042).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('s@x.com','supervisor',null,'Sup',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into client_links (token, wedding_key, title, emails) values ('11111111-1111-1111-1111-111111111111', 'w:sharma', 'Sharma', '{fam@gmail.com}'),
  ('22222222-2222-2222-2222-222222222222', 'w:verma', 'Verma', '{v@gmail.com}');
insert into bookings (wedding_key, title, package_name, items, total, plan) values ('w:sharma', 'Sharma', 'Gold', '[]', 300000, '[]'), ('w:verma', 'Verma', 'Silver', '[]', 50000, '[]');

-- the splitter
select pg_temp.check((select array_agg(title order by n) from sales_deliv_titles('[{"name":"Wedding (Standard)","deliverables":"1 Trailer video (1080p), 2 Vertical short videos; All raw data (if HDD/SSD provided, or a pendrive)."}]'))
  = array['Wedding: 1 Trailer video (1080p)', 'Wedding: 2 Vertical short videos', 'Wedding: All raw data (if HDD/SSD provided, or a pendrive)'], 'deliverables split on , ; but not inside brackets, with the function in front');
select pg_temp.check((select array_agg(title order by n) from sales_deliv_titles('[{"name":"Album","event":"Haldi","deliverables":"30 sheets\n· Box"}]')) = array['Haldi: 30 sheets', 'Haldi: Box'], 'the function name wins; new lines and dots split too');

set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into bank_accounts (name, opening, opening_on) values ('HDFC Current', 100000, current_date - 10);
insert into parties (name, wedding_key) values ('Mr Sharma', 'w:sharma');
insert into client_deliveries (wedding_key, title) values ('w:sharma', 'Haldi: 1 Trailer video');           -- ticked earlier by hand
-- a quotation fills nothing
insert into sales_docs (kind, party, wedding_key, lines) select 'quotation', id, 'w:sharma',
  '[{"name":"Short Event (Standard)","event":"Haldi","qty":1,"rate":15000,"deliverables":"1 Trailer video, 25 Edited photographs"}]' from parties where name = 'Mr Sharma';
select pg_temp.check((select count(*) from client_deliveries) = 1, 'a quotation does not fill deliveries');
-- the bill does
insert into sales_docs (kind, party, wedding_key, lines) select 'invoice', id, 'w:sharma',
  '[{"name":"Short Event (Standard)","event":"Haldi","qty":1,"rate":15000,"deliverables":"1 Trailer video, 25 Edited photographs"},
    {"name":"Wedding (Standard)","event":"Wedding","qty":1,"rate":180000,"deliverables":"1 Trailer video (1080p), 100 Edited photographs"}]' from parties where name = 'Mr Sharma';
select pg_temp.check((select array_agg(title order by sort) from client_deliveries where wedding_key = 'w:sharma')
  = array['Haldi: 1 Trailer video', 'Haldi: 25 Edited photographs', 'Wedding: 1 Trailer video (1080p)', 'Wedding: 100 Edited photographs'], 'the bill fills the rest, once, in its order');
select pg_temp.check((select count(*) from client_deliveries where from_doc is not null and kind = 'bill' and status = 'waiting') = 3, '… as Not started, linked to the bill');
-- the studio works on one, unticks another, then edits the bill
update client_deliveries set status = 'editing' where title = 'Wedding: 1 Trailer video (1080p)';
delete from client_deliveries where title = 'Haldi: 25 Edited photographs';
update sales_docs set lines = '[{"name":"Short Event (Standard)","event":"Haldi","qty":1,"rate":15000,"deliverables":"1 Trailer video, 25 Edited photographs"},
    {"name":"Wedding (Standard)","event":"Wedding","qty":1,"rate":180000,"deliverables":"1 Trailer video (1080p), 1 Album 30 sheets"}]' where kind = 'invoice';
select pg_temp.check((select array_agg(title order by sort) from client_deliveries where wedding_key = 'w:sharma')
  = array['Haldi: 1 Trailer video', 'Wedding: 1 Trailer video (1080p)', 'Wedding: 1 Album 30 sheets'], 'edit: new deliverable added, dropped one removed, unticked one stays away');
-- cancelling the bill removes only what nobody touched
update sales_docs set status = 'cancelled', cancel_why = 'wrong client' where kind = 'invoice';
select pg_temp.check((select array_agg(title order by sort) from client_deliveries where wedding_key = 'w:sharma')
  = array['Haldi: 1 Trailer video', 'Wedding: 1 Trailer video (1080p)'], 'cancelled bill: its untouched lines go, worked-on and hand-ticked stay');
-- a bill of a party linked to the client, without the client on the bill itself
insert into parties (name, wedding_key) values ('Verma ji', 'w:verma');
insert into sales_docs (kind, party, lines) select 'invoice', id, '[{"name":"Pre-wedding Photo Shoot","qty":1,"rate":25000,"deliverables":"50 Edited photographs"}]' from parties where name = 'Verma ji';
select pg_temp.check((select array_agg(title) from client_deliveries where wedding_key = 'w:verma') = array['Pre-wedding Photo Shoot: 50 Edited photographs'], 'the party''s client is used when the bill has none');
-- a bill with no client fills nothing
insert into parties (name) values ('Walk-in');
insert into sales_docs (kind, party, lines) select 'invoice', id, '[{"name":"Passport photos","qty":1,"rate":200,"deliverables":"4 prints"}]' from parties where name = 'Walk-in';
select pg_temp.check((select count(*) from client_deliveries where title like 'Passport%') = 0, 'a bill without a client fills nothing');

-- family payment → Sales desk
reset role; reset request.jwt.claims;
insert into client_pay_claims (wedding_key, amount, paid_on, mode, upi_ref, by_email) values ('w:verma', 20000, current_date, 'UPI', '4123', 'v@gmail.com'), ('w:sharma', 5000, current_date, 'Cash', null, 'fam@gmail.com'), ('w:verma', 100, current_date, 'UPI', null, 'v@gmail.com');
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((client_pay_decide((select id from client_pay_claims where amount = 20000), true, null, null, (select id from bank_accounts limit 1))) ? 'error', 'the supervisor cannot approve');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((client_pay_decide((select id from client_pay_claims where amount = 20000), true, null, null, gen_random_uuid())) ->> 'error' like 'Pick the account%', 'an unknown account is refused');
select set_config('t.r', client_pay_decide((select id from client_pay_claims where amount = 20000), true, null, null, (select id from bank_accounts limit 1))::text, false);
select pg_temp.check(current_setting('t.r')::jsonb ->> 'txn' like 'IN-%', 'approved with an account: a Payment In number comes back');
select pg_temp.check((select count(*) from booking_payments where wedding_key = 'w:verma') = 1 and (select sum(amount) from booking_payments where wedding_key = 'w:verma') = 20000, 'the package gets ONE payment of 20,000');
select pg_temp.check((select note from booking_payments where wedding_key = 'w:verma') like 'Family reported · IN-% · ref 4123', '… noted as family reported with the Sales desk number');
select pg_temp.check((select paid from sales_docs d join parties p on p.id = d.party where p.name = 'Verma ji') = 20000, 'the Verma bill is paid 20,000');
select pg_temp.check((select balance from bank_balances() where name = 'HDFC Current') = 120000, 'the bank balance moved');
select pg_temp.check((select txn is not null and payment is not null from client_pay_claims where amount = 20000), 'the report keeps both links');
-- Sharma: bill cancelled, so the payment stays unlinked (party advance), still one package payment
select set_config('t.r2', client_pay_decide((select id from client_pay_claims where amount = 5000), true, null, 4500, (select id from bank_accounts limit 1))::text, false);
select pg_temp.check((select alloc = '[]' and amount = 4500 and mode = 'Cash' from money_txns where note like 'Family reported%' and amount = 4500), 'no open bill: payment recorded without a bill, the corrected amount');
select pg_temp.check((select count(*) from booking_payments where wedding_key = 'w:sharma') = 1 and (select note from booking_payments where wedding_key = 'w:sharma') like '%they wrote 5000%', 'one package payment, noting what they wrote');
-- without an account: as before (package only)
select pg_temp.check((client_pay_decide((select id from client_pay_claims where amount = 100), true, null, null)) ->> 'ok' = 'true', 'approve without an account still works');
select pg_temp.check((select count(*) from money_txns) = 2 and (select count(*) from booking_payments where wedding_key = 'w:verma') = 2, '… package only, not the Sales desk');
reset role;

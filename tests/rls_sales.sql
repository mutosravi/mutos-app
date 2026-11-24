-- Test for supabase/041_sales.sql (after pg_stub, schema and all files up to 040, WITH 041).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Manager',now()),('sup@x.com','supervisor',null,'Sup',now()),
  ('shrey@x.com','crew','shrey','Shrey',now()),('acc@x.com','accountant',null,'Acc',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
create or replace function pg_temp.fails(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlerrm; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
grant execute on function pg_temp.fails(text) to authenticated, anon;
insert into bookings (wedding_key, title, total) values ('w:sharma', 'Sharma', 300000);

set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into bank_accounts (name, bank, acc_no, opening, opening_on, on_bills, ifsc) values ('HDFC Current', 'HDFC Bank', '50200012344521', 100000, current_date - 10, true, 'HDFC0001234');
insert into bank_accounts (name, kind, opening, opening_on) values ('Cash', 'cash', 5000, current_date - 10);
insert into parties (name, phone, state, wedding_key) values ('Mr Sharma', '9876543210', 'Uttar Pradesh', 'w:sharma');
insert into parties (name, kind, state, gstin) values ('Grand Hotel Pvt Ltd', 'customer', 'Delhi', '07ABCDE1234F1Z5');
insert into parties (name, kind) values ('Album Lab', 'vendor');
select pg_temp.check(pg_temp.fails($q$insert into parties (name, gstin) values ('Bad', 'XYZ')$q$) is not null, 'a wrong GSTIN is refused');

-- quotation: one line per function, a line discount, numbering goes on from myBillBook
insert into sales_docs (kind, party, wedding_key, lines) select 'quotation', id, 'w:sharma',
  '[{"name":"Short Event (Standard)","tier":"standard","event":"Haldi","date":"2027-02-12","qty":1,"rate":15000},
    {"name":"Engagement/Sangeet/Reception (Standard)","tier":"standard","event":"Sangeet","qty":1,"rate":55000,"disc":40},
    {"name":"Wedding (Standard)","tier":"standard","event":"Wedding","qty":1,"rate":180000},
    {"name":"Album 50 Sheets","qty":1,"rate":20000}]' from parties where name = 'Mr Sharma';
select pg_temp.check((select number from sales_docs where kind = 'quotation') = 'MTF2026-27245', 'the quotation number goes on from myBillBook (MTF2026-27245)');
select pg_temp.check((select total from sales_docs where kind = 'quotation') = 248000 and (select discount from sales_docs where kind = 'quotation') = 22000, 'totals come from the lines: 15,000 + 33,000 (40 % off) + 1,80,000 + 20,000 = 2,48,000');
select pg_temp.check((select cgst + sgst + igst from sales_docs where kind = 'quotation') = 0, 'a quotation / plain bill has no GST');
select pg_temp.check(pg_temp.fails($q$update sales_docs set total = 1 where kind = 'quotation'$q$) is null and (select total from sales_docs where kind = 'quotation') = 248000, 'nobody can type a total');
select pg_temp.check(pg_temp.fails($q$insert into sales_docs (kind, party, lines) select 'quotation', id, '[{"name":"Wedding (Standard)","tier":"standard","qty":1,"rate":1},{"name":"Wedding (Premium)","tier":"premium","qty":1,"rate":1}]' from parties where name = 'Mr Sharma'$q$) like '%Standard and Premium%', 'Standard and Premium cannot be on one bill');

-- the bill made from it
insert into sales_docs (kind, party, wedding_key, lines, from_doc) select 'invoice', party, wedding_key, lines, id from sales_docs where kind = 'quotation';
select pg_temp.check((select number from sales_docs where kind = 'invoice') = 'MF/SL/26-27/157' and (select status from sales_docs where kind = 'quotation') = 'converted', 'bill MF/SL/26-27/157 is made from the quotation, which is now converted');

-- GST invoices: same state = CGST + SGST, another state = IGST
insert into sales_docs (kind, party, lines) select 'gst_invoice', id, '[{"name":"Corporate event","qty":1,"rate":10000,"gst":18}]' from parties where name = 'Mr Sharma';
insert into sales_docs (kind, party, lines) select 'gst_invoice', id, '[{"name":"Corporate event","qty":2,"rate":10000,"gst":18}]' from parties where name = 'Grand Hotel Pvt Ltd';
select pg_temp.check((select cgst = 900 and sgst = 900 and igst = 0 and total = 11800 and number = 'MF/G/26-27/21' from sales_docs d join parties p on p.id = d.party where d.kind = 'gst_invoice' and p.name = 'Mr Sharma'), 'GST invoice in Uttar Pradesh: CGST 9 % + SGST 9 % (MF/G/26-27/21)');
select pg_temp.check((select igst = 3600 and cgst = 0 and total = 23600 from sales_docs d join parties p on p.id = d.party where d.kind = 'gst_invoice' and p.name = 'Grand Hotel Pvt Ltd'), 'GST invoice to Delhi: IGST 18 %');

-- payment in, linked to the bill: bill paid, bank up, the client's booking gets it too
insert into money_txns (kind, amount, account, party, mode, ref, alloc)
  select 'in', 50000, (select id from bank_accounts where name = 'HDFC Current'), p.id, 'UPI', 'UTR123',
         jsonb_build_array(jsonb_build_object('doc', d.id, 'amount', 50000))
    from parties p join sales_docs d on d.party = p.id and d.kind = 'invoice' where p.name = 'Mr Sharma';
select pg_temp.check((select paid from sales_docs where kind = 'invoice') = 50000, 'the bill shows ₹50,000 paid');
select pg_temp.check((select balance from bank_balances() where name = 'HDFC Current') = 150000, 'HDFC balance: 1,00,000 typed + 50,000 in = 1,50,000');
select pg_temp.check((select count(*) from booking_payments where wedding_key = 'w:sharma' and amount = 50000 and note like 'Sales desk IN-231%') = 1, 'the client''s booking has the payment (family page, 90 % rule)');
select pg_temp.check((select number from money_txns where kind = 'in') = 'IN-231', 'payment numbers go on from myBillBook');
select pg_temp.check(pg_temp.fails($q$insert into money_txns (kind, amount, account, party, alloc) select 'in', 300000, (select id from bank_accounts limit 1), p.id, jsonb_build_array(jsonb_build_object('doc', d.id, 'amount', 300000)) from parties p join sales_docs d on d.party = p.id and d.kind = 'invoice' where p.name = 'Mr Sharma'$q$) like '%More than the bill%', 'paying more than the bill is refused');
select pg_temp.check(pg_temp.fails($q$insert into money_txns (kind, amount, account, party, alloc) select 'in', 10, (select id from bank_accounts limit 1), (select id from parties where name = 'Album Lab'), jsonb_build_array(jsonb_build_object('doc', d.id, 'amount', 10)) from sales_docs d where d.kind = 'invoice'$q$) like '%another party%', 'a payment cannot go against another party''s bill');
select pg_temp.check(pg_temp.fails($q$update sales_docs set status = 'cancelled', cancel_why = 'x' where kind = 'invoice'$q$) like '%Payments are linked%', 'a bill with payments cannot be cancelled');
select pg_temp.check(pg_temp.fails($q$update sales_docs set lines = '[{"name":"x","qty":1,"rate":100}]' where kind = 'invoice'$q$) like '%cannot be less%', 'a bill cannot be cut below what is paid');

-- expenses, a purchase paid out, a transfer
insert into money_txns (kind, amount, account, category, note) select 'expense', 3548.6, id, 'Transportation & Travel', 'Agra trip' from bank_accounts where name = 'Cash';
select pg_temp.check(pg_temp.fails($q$insert into money_txns (kind, amount, account) select 'expense', 10, id from bank_accounts where name = 'Cash'$q$) like '%what the expense%', 'an expense needs what it was for');
insert into sales_docs (kind, party, lines) select 'purchase', id, '[{"name":"Albums","qty":2,"rate":3225}]' from parties where name = 'Album Lab';
insert into money_txns (kind, amount, account, party, alloc) select 'out', 6450, (select id from bank_accounts where name = 'HDFC Current'), d.party, jsonb_build_array(jsonb_build_object('doc', d.id, 'amount', 6450)) from sales_docs d where d.kind = 'purchase';
insert into money_txns (kind, amount, account, to_account) select 'transfer', 2000, (select id from bank_accounts where name = 'HDFC Current'), (select id from bank_accounts where name = 'Cash');
select pg_temp.check((select balance from bank_balances() where name = 'HDFC Current') = 141550 and (select balance from bank_balances() where name = 'Cash') = 3451.4, 'balances: HDFC 1,50,000 − 6,450 − 2,000; Cash 5,000 − 3,548.60 + 2,000');
select pg_temp.check((select paid from sales_docs where kind = 'purchase') = 6450, 'the purchase is paid');
select pg_temp.check((select balance from party_balances() b join parties p on p.id = b.id where p.name = 'Mr Sharma') = 248000 + 11800 - 50000, 'Mr Sharma still owes 2,48,000 + 11,800 − 50,000');
select pg_temp.check((select balance from party_balances() b join parties p on p.id = b.id where p.name = 'Album Lab') = 0, 'nothing owed to Album Lab');

-- cancelling a payment: reason needed, bank and booking follow
select pg_temp.check(pg_temp.fails($q$update money_txns set status = 'cancelled' where kind = 'in'$q$) like '%why%', 'cancelling a payment needs a reason');
update money_txns set status = 'cancelled', cancel_why = 'bounced' where kind = 'in';
select pg_temp.check((select paid from sales_docs where kind = 'invoice') = 0 and (select balance from bank_balances() where name = 'HDFC Current') = 91550, 'the bill and the bank go back');
select pg_temp.check((select count(*) from booking_payments where wedding_key = 'w:sharma') = 0, 'and the booking''s copy is gone');
select pg_temp.check(pg_temp.fails($q$update money_txns set amount = 1 where kind = 'in'$q$) like '%cancelled%', 'a cancelled payment cannot be changed');
select pg_temp.check((select count(*) from sales_log where what like 'Cancelled in IN-231: bounced%') = 1 and (select count(*) from sales_log) >= 8, 'everything is in the log');
select pg_temp.check(pg_temp.fails($q$delete from sales_docs$q$) is not null and pg_temp.fails($q$delete from money_txns$q$) is not null, 'nothing can be deleted');
update bank_accounts set opening = 120000 where name = 'HDFC Current';
select pg_temp.check((select count(*) from sales_log where what like 'Opening balance of HDFC Current: ₹100000%') = 1, 'changing a typed balance is logged');

-- the share link
reset role;
select token as qtoken from sales_docs where kind = 'quotation' \gset
set role anon; set request.jwt.claims = '{}';
select pg_temp.check((sales_doc_view(:'qtoken')) ->> 'number' = 'MTF2026-27245', 'the share link opens the quotation without signing in');
reset role;
select pg_temp.check((select (sales_doc_view(token)) -> 'banks' -> 0 ->> 'acc_no' from sales_docs where kind = 'quotation') = '50200012344521', 'it shows the bank account picked for bills, so the family can pay');
select pg_temp.check((select (sales_doc_view(token)) -> 'company' ->> 'gstin' from sales_docs where kind = 'quotation') is null, 'no GSTIN on a plain quotation');
set role anon;
select pg_temp.check((sales_doc_view('nope')) ? 'error', 'a made-up link shows nothing');
select pg_temp.check(pg_temp.fails('select count(*) from sales_docs') is not null, 'anon cannot read the tables');

-- who can see it: admin and manager only
reset role; set role authenticated;
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from sales_docs) = 5 and (select count(*) from bank_balances()) = 2, 'the manager sees everything');
insert into parties (name) values ('Walk-in');
do $$ begin perform pg_temp.check(true, 'the manager adds a party'); end $$;
set request.jwt.claims = '{"email":"sup@x.com"}';
select pg_temp.check((select count(*) from sales_docs) = 0 and (select count(*) from parties) = 0 and (select count(*) from bank_balances()) = 0 and (select count(*) from money_txns) = 0, 'the supervisor sees nothing');
select pg_temp.check(pg_temp.fails($q$insert into parties (name) values ('x')$q$) is not null, 'and cannot add');
set request.jwt.claims = '{"email":"acc@x.com"}';
select pg_temp.check((select count(*) from money_txns) = 0 and (select count(*) from party_balances()) = 0, 'the accountant sees nothing (Ravi: admin + manager)');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((select count(*) from sales_settings) = 0 and (select count(*) from sale_items) = 0, 'crew see nothing');
reset role;
select pg_temp.check((select count(*) from sale_items where name = 'Short Event (Standard)' and hours = 5) = 1 and (select data ->> 'terms' from sales_settings) like '%maximum 5 hours%', 'price list and terms start with short events = 5 hours');
-- editing a party (24 Nov 2026: the change log read a bank-account field on parties and every party edit failed)
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
update parties set phone = '9876500001', wedding_key = 'w:sharma' where name = 'Mr Sharma';
update parties set opening = opening + 100 where name = 'Mr Sharma';
select pg_temp.check((select phone from parties where name = 'Mr Sharma') = '9876500001' and exists (select 1 from sales_log where what like 'Opening balance of Mr Sharma%'), 'a party can be edited and linked to its client; an opening change is logged');
update bank_accounts set opening = opening + 1 where name = 'HDFC Current';
select pg_temp.check(exists (select 1 from sales_log where what like 'Opening balance of HDFC Current%'), 'a bank account''s opening change is still logged');
reset role;

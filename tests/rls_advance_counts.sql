-- Test for supabase/045_advance_counts.sql (after pg_stub, schema and every file up to 044, then 045).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into client_links (token, wedding_key, title, emails) values ('11111111-1111-1111-1111-111111111111', 'w:sharma', 'Sharma', '{fam@gmail.com}');
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into bank_accounts (name, opening, opening_on) values ('HDFC Current', 0, current_date - 10);
insert into parties (name, wedding_key) values ('Mr Sharma', 'w:sharma'), ('Someone else', null);
insert into sales_docs (kind, party, lines) select 'invoice', id, '[{"name":"Wedding","qty":1,"rate":100000}]' from parties where name = 'Mr Sharma';
-- 50,000 set against the bill, 45,000 saved without picking the bill (an advance)
insert into money_txns (kind, amount, account, party, alloc) select 'in', 50000, (select id from bank_accounts), p.id, jsonb_build_array(jsonb_build_object('doc', d.id, 'amount', 50000))
  from parties p join sales_docs d on d.party = p.id where p.name = 'Mr Sharma';
insert into money_txns (kind, amount, account, party) select 'in', 45000, (select id from bank_accounts), id from parties where name = 'Mr Sharma';
select pg_temp.check((select paid from sales_docs where party = (select id from parties where name = 'Mr Sharma')) = 50000, 'the bill itself shows 50,000 paid (accounts unchanged)');
select pg_temp.check((client_money('w:sharma') ->> 'paid')::numeric = 95000 and (client_money('w:sharma') ->> 'open')::boolean, 'the advance counts: 95,000 of 1,00,000, deliveries open');
-- part of a payment set against a bill, the rest an advance
insert into money_txns (kind, amount, account, party) select 'in', 7000, (select id from bank_accounts), id from parties where name = 'Someone else';
select pg_temp.check((client_money('w:sharma') ->> 'paid')::numeric = 95000, 'another party''s money does not count');
-- a cancelled advance does not count
update money_txns set status = 'cancelled', cancel_why = 'typed twice' where amount = 45000;
select pg_temp.check((client_money('w:sharma') ->> 'paid')::numeric = 50000 and not (client_money('w:sharma') ->> 'open')::boolean, 'cancelled: back to 50,000, closed');
-- a payment partly set against the bill: only the rest is an advance
insert into money_txns (kind, amount, account, party, alloc) select 'in', 45000, (select id from bank_accounts), p.id, jsonb_build_array(jsonb_build_object('doc', d.id, 'amount', 20000))
  from parties p join sales_docs d on d.party = p.id where p.name = 'Mr Sharma';
select pg_temp.check((client_money('w:sharma') ->> 'paid')::numeric = 95000, '20,000 on the bill + 25,000 advance = 95,000 (not counted twice)');
reset role;

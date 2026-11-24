-- Test for supabase/044_client_after_event.sql (after pg_stub, schema and every file up to 043, then 044).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('s@x.com','supervisor',null,'Sup',now()),('hamza@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into client_links (token, wedding_key, title, emails) values ('11111111-1111-1111-1111-111111111111', 'w:sharma', 'Sharma', '{fam@gmail.com}'),
  ('22222222-2222-2222-2222-222222222222', 'w:verma', 'Verma', '{v@gmail.com}');
update sales_settings set data = data || '{"phone":"+91 98765 00000"}'::jsonb where id = 1;

set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into parties (name, wedding_key) values ('Mr Sharma', 'w:sharma'), ('Verma ji', 'w:verma');
insert into sales_docs (kind, party, lines) select 'invoice', id, '[{"name":"Wedding","qty":1,"rate":200000}]' from parties where name = 'Mr Sharma';
insert into sales_docs (kind, party, lines) select 'quotation', id, '[{"name":"Album","qty":1,"rate":20000}]' from parties where name = 'Mr Sharma';
insert into sales_docs (kind, party, lines) select 'invoice', id, '[{"name":"Birthday","qty":1,"rate":15000}]' from parties where name = 'Verma ji';

-- the family sees its own bills (not quotations, not another family's) and Muto's phone
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select set_config('t.b', client_bills('11111111-1111-1111-1111-111111111111')::text, false);
select pg_temp.check(jsonb_array_length(current_setting('t.b')::jsonb -> 'bills') = 1 and (current_setting('t.b')::jsonb -> 'bills' -> 0 ->> 'total')::numeric = 200000
  and current_setting('t.b')::jsonb -> 'bills' -> 0 ->> 'token' is not null, 'family: its one bill with the link to open it (no quotation, not Verma''s)');
select pg_temp.check(current_setting('t.b')::jsonb ->> 'phone' = '+919876500000', 'family: Muto''s phone, cleaned for a Call button');
select pg_temp.check((client_bills('22222222-2222-2222-2222-222222222222')) ? 'error', 'a family cannot see another family''s bills');
-- requests
select pg_temp.check((client_request('11111111-1111-1111-1111-111111111111', '', null)) ? 'error', 'a request needs what is wanted');
select pg_temp.check((client_request('11111111-1111-1111-1111-111111111111', 'Extra album', '30 sheets for the grandparents')) ->> 'ok' = 'true', 'family asks for an extra album');
select pg_temp.check((client_request('22222222-2222-2222-2222-222222222222', 'Extra album', null)) ? 'error', '… but not for another family');
do $$ begin
  begin insert into client_requests (wedding_key, what, by_email) values ('w:sharma', 'x', 'fam@gmail.com'); raise exception 'FAIL family inserted directly';
  exception when insufficient_privilege then raise notice 'PASS no direct writes to requests'; end;
end $$;
select pg_temp.check((select count(*) from client_requests) = 0, 'the family cannot read the requests table itself');
select pg_temp.check(client_bills('11111111-1111-1111-1111-111111111111') -> 'requests' -> 0 ->> 'status' = 'new', '… it sees its request through its page ("new")');
-- the crew and the supervisor see nothing, the supervisor cannot answer
set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.check((client_bills('11111111-1111-1111-1111-111111111111')) ? 'error' and (select count(*) from client_requests) = 0, 'crew: no bills, no requests');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((client_request_set((select id from client_requests limit 1), 'done', null)) ? 'error', 'the supervisor cannot answer a request');
-- the manager answers
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from client_requests where status = 'new') = 1, 'the manager sees the new request');
select pg_temp.check((client_request_set((select id from client_requests limit 1), 'declined', '')) ->> 'error' like 'Write a short answer%', 'declining needs an answer for the family');
select pg_temp.check((client_request_set((select id from client_requests limit 1), 'done', 'Album ordered, ready in 2 weeks')) ->> 'ok' = 'true', 'marked done with an answer');
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select pg_temp.check(client_bills('11111111-1111-1111-1111-111111111111') -> 'requests' -> 0 ->> 'reply' = 'Album ordered, ready in 2 weeks', 'the family sees the answer');
-- at most 5 open
select client_request('11111111-1111-1111-1111-111111111111', 'More photos ' || g, null) from generate_series(1, 5) g;
select pg_temp.check((client_request('11111111-1111-1111-1111-111111111111', 'One more', null)) ->> 'error' like '%still looking%', 'at most 5 open requests');
reset role;

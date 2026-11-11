-- Test for supabase/015_card_notify.sql (after pg_stub, schema, 002–005, 007–014, 015).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('shrey@x.com','crew','shrey','Shrey',now()) on conflict do nothing;
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into push_subs (endpoint, person_key, p256dh, auth) values ('https://p/o', 'email:o@x.com', 'k', 'a');
select pg_temp.check((select count(*) from push_subs) = 1, 'the owner turns on notices on his phone (under his Gmail)');
select pg_temp.expect_fail($$insert into push_subs (endpoint, person_key, p256dh, auth) values ('https://p/x', 'email:m@x.com', 'k', 'a')$$, 'signing up under someone else''s Gmail');
select pg_temp.expect_fail($$insert into push_subs (endpoint, person_key, p256dh, auth) values ('https://p/y', 'shrey', 'k', 'a')$$, 'signing up under a crew key');
set request.jwt.claims = '{"email":"shrey@x.com"}';
insert into push_subs (endpoint, person_key, p256dh, auth) values ('https://p/s', 'shrey', 'k', 'a');
select pg_temp.check((select count(*) from push_subs) = 1, 'crew still sign up under their board key, and see only their own');
select pg_temp.expect_fail($$insert into push_subs (endpoint, person_key, p256dh, auth) values ('https://p/s2', 'email:shrey@x.com', 'k', 'a')$$, 'crew use their board key, not their Gmail');
delete from push_subs where endpoint = 'https://p/o';
set request.jwt.claims = '{"email":"family@x.com"}';
select pg_temp.expect_fail($$insert into push_subs (endpoint, person_key, p256dh, auth) values ('https://p/f', 'email:family@x.com', 'k', 'a')$$, 'a family Gmail (no login) cannot sign up');
reset role;
select pg_temp.check((select count(*) from push_subs) = 2, 'nobody removed someone else''s phone');
select 'ALL NOTIFY CHECKS PASSED';

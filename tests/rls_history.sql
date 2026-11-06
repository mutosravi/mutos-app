-- Access-rule test for supabase/010_history.sql (after the stub, schema, 002–005, 007–010).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('acc@x.com','accountant',null,'Acc',now()),('hamza@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
update people set email = 'hamza@x.com' where name = 'Hamza';
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;
insert into salary_history (person, month, data) select id, '2026-10', '{"salary": 9000, "presents": 12, "net": 6187}' from people where name in ('Hamza', 'Saif');
set role authenticated; set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.check((select count(*) from salary_history) = 1 and (select (data->>'net')::numeric from salary_history) = 6187, 'an employee sees only their own months');
select pg_temp.expect_fail($$insert into salary_history (person, month, data) values (public.my_person(), '2026-09', '{}')$$, 'an employee adding history');
set request.jwt.claims = '{"email":"acc@x.com"}';
select pg_temp.check((select count(*) from salary_history) = 2, 'the accountant sees everyone''s history');
select pg_temp.expect_fail($$update salary_history set data = '{}' where true returning 1/0$$, 'the accountant changing history');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from salary_history) = 0, 'the partner does not see salaries');
set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((select count(*) from salary_history) = 2, 'the owner sees all');
reset role;
set role anon; set request.jwt.claims = '{}';
select pg_temp.expect_fail($$select * from salary_history$$, 'visitor reading salaries');
reset role;
select 'ALL HISTORY CHECKS PASSED';

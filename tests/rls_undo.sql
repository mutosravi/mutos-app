-- Test for supabase/013_undo_punch.sql (after pg_stub, schema, 002–005, 007–012, 013).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('e@x.com','staff',null,'Emp',now()),('f@x.com','staff',null,'Other',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into att_punch (email, day, kind, at) values
  ('e@x.com', today_ist(), 'in', now() - interval '4 hours'),
  ('e@x.com', today_ist(), 'out', now() - interval '2 minutes'),
  ('f@x.com', today_ist(), 'in', now() - interval '1 minute');
set role authenticated; set request.jwt.claims = '{"email":"e@x.com"}';
select pg_temp.check((att_undo()) ->> 'kind' = 'out', 'a check-out tapped 2 minutes ago is undone');
reset role;
select pg_temp.check((select count(*) from att_punch where email = 'e@x.com') = 1 and (select count(*) from att_punch where email = 'f@x.com') = 1, 'only that one tap is removed; other people are untouched');
select pg_temp.check((select count(*) from att_log where by_email = 'e@x.com' and what like 'Undid a mistaken check-out%') = 1, 'the undo is in the attendance log');
set role authenticated; set request.jwt.claims = '{"email":"e@x.com"}';
select pg_temp.check((att_undo()) ? 'error', 'the check-in from 4 hours ago cannot be undone (over 10 minutes)');
reset role;
insert into att_punch (email, day, kind, at, by_fix) values ('e@x.com', today_ist(), 'out', now() - interval '1 minute', true);
set role authenticated; set request.jwt.claims = '{"email":"e@x.com"}';
select pg_temp.check((att_undo()) ? 'error', 'a time set by an approved correction cannot be undone');
set request.jwt.claims = '{"email":"nobody@x.com"}';
select pg_temp.check((att_undo()) ? 'error', 'someone with no taps today has nothing to undo');
reset role;
select pg_temp.check((select count(*) from att_punch) = 3, 'nothing else was removed');
select 'ALL UNDO CHECKS PASSED';

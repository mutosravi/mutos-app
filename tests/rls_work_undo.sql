-- Test for supabase/027_work_undo_and_data.sql (after pg_stub, schema and every file up to 026, then 027).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('hamza@x.com','crew','hamza','Hamza',now()),('saif@x.com','crew','saif','Saif',now()) on conflict do nothing;
update people set email = 'hamza@x.com' where name = 'Hamza';
update people set email = 'saif@x.com' where name = 'Saif';
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into work_jobs (wedding_key, wedding_title, kind, assignee) values ('w:sharma', 'Sharma', 'reel', (select id from people where name = 'Hamza'));
select set_config('t.j', (select id::text from work_jobs where wedding_key = 'w:sharma'), false);
-- ── 1. undo a status tapped by mistake ──
set request.jwt.claims = '{"email":"hamza@x.com"}';
update work_jobs set status = 'editing' where id = current_setting('t.j')::uuid;
select pg_temp.check((select prev_status from work_jobs where id = current_setting('t.j')::uuid) = 'todo' and (select status_by from work_jobs where id = current_setting('t.j')::uuid) = 'hamza@x.com', 'Start: the job remembers it was To do, and who started it');
update work_jobs set status = 'todo' where id = current_setting('t.j')::uuid;
select pg_temp.check((select status from work_jobs where id = current_setting('t.j')::uuid) = 'todo' and (select started_at from work_jobs where id = current_setting('t.j')::uuid) is null, 'Hamza puts it back to To do (started time cleared)');
select pg_temp.expect_fail($$update work_jobs set status = 'todo' where id = current_setting('t.j')::uuid and status = 'todo'; update work_jobs set status = 'editing' where id = current_setting('t.j')::uuid; update work_jobs set status = 'rendered' where id = current_setting('t.j')::uuid; update work_jobs set status = 'todo' where id = current_setting('t.j')::uuid$$, 'only one step back: Rendered cannot jump to To do');
update work_jobs set status = 'editing' where id = current_setting('t.j')::uuid;
update work_jobs set status = 'rendered' where id = current_setting('t.j')::uuid;
update work_jobs set status = 'editing' where id = current_setting('t.j')::uuid;
select pg_temp.check((select status from work_jobs where id = current_setting('t.j')::uuid) = 'editing', 'Rendered tapped by mistake → back to Editing');
update work_jobs set prev_status = 'final', status_by = 'x' where id = current_setting('t.j')::uuid;
select pg_temp.check((select prev_status from work_jobs where id = current_setting('t.j')::uuid) is distinct from 'final', 'nobody writes the memory by hand');
-- the studio's own changes cannot be undone by the editor
set request.jwt.claims = '{"email":"m@x.com"}';
update work_jobs set status = 'sent' where id = current_setting('t.j')::uuid;
set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.expect_fail($$update work_jobs set status = 'editing' where id = current_setting('t.j')::uuid$$, 'Sent by the studio: the editor cannot put it back');
set request.jwt.claims = '{"email":"m@x.com"}';
update work_jobs set status = 'changes' where id = current_setting('t.j')::uuid;
set request.jwt.claims = '{"email":"hamza@x.com"}';
update work_jobs set status = 'editing' where id = current_setting('t.j')::uuid;
update work_jobs set status = 'changes' where id = current_setting('t.j')::uuid;
select pg_temp.check((select status from work_jobs where id = current_setting('t.j')::uuid) = 'changes' and (select round from work_jobs where id = current_setting('t.j')::uuid) = 2, '"Start the changes" tapped by mistake → back to Changes asked (no new round)');
set request.jwt.claims = '{"email":"saif@x.com"}';
update work_jobs set status = 'editing' where id = current_setting('t.j')::uuid;
reset role;
select pg_temp.check((select status from work_jobs where id = current_setting('t.j')::uuid) = 'changes', 'someone else cannot touch the job (not theirs)');
alter table work_jobs disable trigger work_job_rules;
update work_jobs set status = 'editing', prev_status = 'changes', status_by = 'hamza@x.com', status_at = now() - interval '2 days' where id = current_setting('t.j')::uuid;
alter table work_jobs enable trigger work_job_rules;
set role authenticated; set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.expect_fail($$update work_jobs set status = 'changes' where id = current_setting('t.j')::uuid$$, 'after 24 hours there is no undo (ask the studio)');
-- ── 2. where the data is ──
reset role;
insert into drives (name, kind) values ('M 5', 'SSD'), ('Dibba 2', 'HDD');
select set_config('mutos.quiet', '1', false); update drives set holder = (select id from people where name = 'Saif') where name = 'Dibba 2'; select set_config('mutos.quiet', '', false);
insert into drive_items (drive, wedding_key, title, what) values ((select id from drives where name = 'M 5'), 'w:sharma', 'Sharma · Haldi', 'raw'), ((select id from drives where name = 'Dibba 2'), 'w:sharma', 'Sharma · Haldi', 'backup'),
  ((select id from drives where name = 'M 5'), null, 'Sharma wedding (old sheet)', 'project'), ((select id from drives where name = 'M 5'), 'w:gupta', 'Gupta · Mehndi', 'raw');
insert into drive_items (drive, wedding_key, title, what) values ((select id from drives where name = 'M 5'), 'w:sharma', 'Sharma · gone', 'raw');
update drive_items set removed_at = now(), removed_why = 'cleaned' where title = 'Sharma · gone';
set role authenticated; set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.check(jsonb_array_length(job_data(current_setting('t.j')::uuid) -> 'lines') = 3, 'Hamza (job assigned to him) sees the 3 Sharma lines: raw, backup and the old-sheet project (not Gupta, not removed ones)');
select pg_temp.check(exists (select 1 from jsonb_array_elements(job_data(current_setting('t.j')::uuid) -> 'lines') l where l ->> 'drive' = 'Dibba 2' and l ->> 'where' = 'With Saif' and l ->> 'what' = 'backup')
  and exists (select 1 from jsonb_array_elements(job_data(current_setting('t.j')::uuid) -> 'lines') l where l ->> 'drive' = 'M 5' and l ->> 'where' = 'In the office'), '… with the drive and where it is now (office / with Saif)');
set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check(job_data(current_setting('t.j')::uuid) ? 'error', 'someone whose job it is not: no');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check(jsonb_array_length(job_data(current_setting('t.j')::uuid) -> 'lines') = 3, 'the studio desk too');
reset role;

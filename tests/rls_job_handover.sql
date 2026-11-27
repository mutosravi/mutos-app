-- Test for supabase/047_job_handover.sql (after pg_stub, schema and every file up to 046, then 047).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('s@x.com','supervisor',null,'Sup',now()),
  ('ed@x.com','staff',null,'Editor',now()),('ed2@x.com','staff',null,'Editor 2',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into people (name, email) values ('Rahul Editor', 'ed@x.com'), ('Other Editor', 'ed2@x.com');
insert into client_links (token, wedding_key, title, emails, deliveries_open) values ('11111111-1111-1111-1111-111111111111', 'w:sharma', 'Sharma', '{fam@gmail.com}', true);
insert into client_deliveries (wedding_key, title, status, sort) values ('w:sharma', 'Reel', 'waiting', 0), ('w:sharma', 'Wedding Trailer', 'waiting', 1);
set request.jwt.claims = '{"email":"o@x.com"}';
insert into work_jobs (wedding_key, wedding_title, kind, title, assignee) select 'w:sharma', 'Sharma', 'reel', 'Reel', id from people where email = 'ed@x.com';
insert into work_jobs (wedding_key, wedding_title, kind, title, assignee) select 'w:sharma', 'Sharma', 'trailer', 'Wedding Trailer', id from people where email = 'ed@x.com';

select set_config('t.reel', (select id::text from client_deliveries where title = 'Reel'), false);
set role authenticated;
-- another editor cannot hand over, nor start an upload
set request.jwt.claims = '{"email":"ed2@x.com"}';
select pg_temp.check((job_upload_begin((select id from work_jobs where title = 'Reel'), 'reel.mp4', 'video/mp4', 1000)) ? 'error', 'another editor cannot upload for this job');
-- the editor starts: the family sees "Being edited" once the job is linked; editors cannot write the review columns
set request.jwt.claims = '{"email":"ed@x.com"}';
update work_jobs set status = 'editing' where title = 'Reel';
do $$ begin
  begin update work_jobs set review = 'approved' where title = 'Reel'; raise exception 'FAIL editor approved own work';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS an editor cannot approve by writing the row'; end;
  begin update work_jobs set delivery = current_setting('t.reel')::uuid where title = 'Reel'; raise exception 'FAIL editor linked delivery';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS only the studio links a job to a delivery'; end;
end $$;
-- upload: a pending row, then (as the Worker would) the file is marked done
select set_config('t.u', (job_upload_begin((select id from work_jobs where title = 'Reel'), 'Sharma reel v1.mp4', 'video/mp4', 524288000) ->> 'id'), false);
select pg_temp.check(current_setting('t.u') <> '', 'the editor starts an upload (a 500 MB video)');
select pg_temp.check((job_upload_begin((select id from work_jobs where title = 'Reel'), 'huge.mov', 'video/quicktime', 30::bigint * 1024 * 1024 * 1024)) ->> 'error' like 'Files over 20 GB%', 'over 20 GB: hand over a link instead');
select pg_temp.check((job_handover((select id from work_jobs where title = 'Reel'), null, current_setting('t.u')::uuid, null)) ->> 'error' like '%not finished%', 'cannot hand over before the upload has finished');
reset role; update uploads set status = 'ok', drive_id = 'drive-file-1' where id = current_setting('t.u')::uuid; set role authenticated; set request.jwt.claims = '{"email":"ed@x.com"}';
select pg_temp.check((job_file(current_setting('t.u')::uuid)) ->> 'drive_id' = 'drive-file-1', 'the editor can preview his own file');
select set_config('t.h', job_handover((select id from work_jobs where title = 'Reel'), null, current_setting('t.u')::uuid, 'Music as discussed')::text, false);
select pg_temp.check((current_setting('t.h')::jsonb ->> 'ok')::boolean and current_setting('t.h')::jsonb ->> 'delivery' = current_setting('t.reel'), 'handed over; linked by itself to the family''s "Reel" line');
select pg_temp.check((select status = 'rendered' and review = 'waiting' and hand_note = 'Music as discussed' from work_jobs where title = 'Reel'), 'the job is Rendered and waits for a check');
reset role; select pg_temp.check((select status from client_deliveries where title = 'Reel') = 'editing', 'the family sees "Being edited", not the file'); set role authenticated; set request.jwt.claims = '{"email":"ed@x.com"}';
select pg_temp.check((job_review((select id from work_jobs where title = 'Reel'), true, null, 'https://drive.google.com/x')) ? 'error', 'the editor cannot approve');
-- link hand over (no upload)
select pg_temp.check((job_handover((select id from work_jobs where title = 'Wedding Trailer'), 'not a link', null, null)) ->> 'error' like '%https://%', 'a hand over needs a file or an https link');
select pg_temp.check((job_handover((select id from work_jobs where title = 'Wedding Trailer'), 'https://drive.google.com/trailer', null, null)) ->> 'ok' = 'true', 'the trailer handed over as a Drive link');
-- supervisor cannot approve
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((job_review((select id from work_jobs where title = 'Reel'), true, null, 'https://drive.google.com/x')) ? 'error', 'the supervisor cannot approve');
-- the manager asks for changes on the reel
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((job_review((select id from work_jobs where title = 'Reel'), false, '', null)) ->> 'error' like 'Write what needs%', 'changes need a note for the editor');
select pg_temp.check((job_review((select id from work_jobs where title = 'Reel'), false, 'Shorter intro please', null)) ->> 'ok' = 'true', 'manager: changes needed');
select pg_temp.check((select status = 'changes' and round = 2 and review = 'changes' and review_note = 'Shorter intro please' from work_jobs where title = 'Reel'), 'the job goes back to the editor as round 2 with the note');
select pg_temp.check((select status from client_deliveries where title = 'Reel') = 'editing' and (select link from client_deliveries where title = 'Reel') is null, 'the family still sees "Being edited", no link');
-- round 2: the editor hands over again, the admin approves with the shared link
set request.jwt.claims = '{"email":"ed@x.com"}';
select pg_temp.check((job_handover((select id from work_jobs where title = 'Reel'), null, current_setting('t.u')::uuid, 'Shorter now')) ->> 'ok' = 'true', 'round 2 handed over');
set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((job_review((select id from work_jobs where title = 'Reel'), true, null, null)) ->> 'error' like '%could not be shared%', 'an uploaded file needs the shared Drive link to approve');
select pg_temp.check((job_review((select id from work_jobs where title = 'Reel'), true, null, 'https://drive.google.com/file/d/drive-file-1/view')) ->> 'ok' = 'true', 'admin approves');
select pg_temp.check((select status = 'ready' and link like 'https://drive.google.com/file/d/drive-file-1%' and shared and upload = current_setting('t.u')::uuid from client_deliveries where title = 'Reel'), 'the family''s Reel is Ready with the link (shared, from the upload)');
select pg_temp.check((select status = 'sent' and review = 'approved' from work_jobs where title = 'Reel'), 'the job is Sent');
select pg_temp.check((job_review((select id from work_jobs where title = 'Wedding Trailer'), true, null, null)) ->> 'ok' = 'true', 'trailer approved');
select pg_temp.check(true
  and (select status = 'ready' and link = 'https://drive.google.com/trailer' and not shared from client_deliveries where title = 'Wedding Trailer'), 'the trailer link goes to the family as it is');
-- the family sees it through client_after
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select pg_temp.check((select bool_and(x ->> 'link' is not null) from jsonb_array_elements(client_after('11111111-1111-1111-1111-111111111111') -> 'deliveries') x), 'the family gets both links');
-- a sent job cannot be handed over again until the studio marks changes
set request.jwt.claims = '{"email":"ed@x.com"}';
select pg_temp.check((job_handover((select id from work_jobs where title = 'Reel'), 'https://x.y/z', null, null)) ->> 'error' like '%already sent%', 'a sent job: no new hand over until Muto''s marks changes');
reset role;

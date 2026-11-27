-- 047 (27 Nov 2026, Ravi: "an uploading option to the editors on work assigned … he can upload through app to the work assigned and it
-- shows to the client"; decided: Editor → Muto's approves → client). Run after 046 (needs 026 photos, 035/046 deliveries, 007/027 jobs).
--   · A job can point at the family's delivery line (work_jobs.delivery). When the editor starts, a "Not started" line turns "Being edited".
--   · The editor hands over (job_handover): a file uploaded from the app (straight from the browser into the studio Google Drive,
--     Families/<client>/Deliveries; uploads kind 'job') or a Drive link. The job becomes Rendered and waits for review ('waiting').
--   · The admin / manager checks it (job_review): Approve → job "Sent", the delivery line Ready with the link (an uploaded file is shared
--     "anyone with the link" by the Worker at that moment, and unshared by the Worker after the line's "Download till" day);
--     Changes needed → job "Changes" (next round) with the note the editor sees.
--   · Only the editor the job is assigned to (or the admin / manager) can hand over; only the admin / manager can approve.

alter table public.uploads drop constraint if exists uploads_kind_check;
alter table public.uploads add constraint uploads_kind_check check (kind in ('card', 'client', 'person', 'job'));
alter table public.uploads drop constraint if exists uploads_purpose_check;
alter table public.uploads add constraint uploads_purpose_check check (purpose in ('card', 'vip', 'ref', 'pay', 'avatar', 'delivery'));
alter table public.uploads drop constraint if exists uploads_mime_check;
alter table public.uploads add constraint uploads_mime_check check (mime like 'image/%' or (kind = 'job' and length(mime) between 3 and 100));
alter table public.uploads add column if not exists job uuid;

alter table public.work_jobs add column if not exists delivery uuid references public.client_deliveries(id) on delete set null;
alter table public.work_jobs add column if not exists hand_upload uuid;
alter table public.work_jobs add column if not exists hand_note text check (length(hand_note) <= 300);
alter table public.work_jobs add column if not exists hand_at timestamptz;
alter table public.work_jobs add column if not exists hand_by text;
alter table public.work_jobs add column if not exists review text check (review in ('waiting', 'approved', 'changes'));
alter table public.work_jobs add column if not exists review_note text check (length(review_note) <= 300);
alter table public.work_jobs add column if not exists reviewed_by text;
alter table public.work_jobs add column if not exists reviewed_at timestamptz;
create index if not exists work_jobs_review on public.work_jobs (review) where review = 'waiting';

alter table public.client_deliveries add column if not exists job uuid;
alter table public.client_deliveries add column if not exists upload uuid;
alter table public.client_deliveries add column if not exists shared boolean not null default false;

-- the handover / review columns change only inside the functions below (the admin / manager may still link a delivery by hand)
create or replace function public.work_jobs_hand_guard() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('mutos.hand', true), '') = '1' then return new; end if;
  if row(new.hand_upload, new.hand_note, new.hand_at, new.hand_by, new.review, new.review_note, new.reviewed_by, new.reviewed_at)
     is distinct from row(old.hand_upload, old.hand_note, old.hand_at, old.hand_by, old.review, old.review_note, old.reviewed_by, old.reviewed_at) then
    raise exception 'Hand over and approve through the app.';
  end if;
  if new.delivery is distinct from old.delivery and not public.is_staff() then
    raise exception 'Only the admin or the manager can link a job to a client''s delivery.';
  end if;
  return new;
end $$;
drop trigger if exists work_jobs_hand_guard on public.work_jobs;
create trigger work_jobs_hand_guard before update on public.work_jobs for each row execute function public.work_jobs_hand_guard();

-- the family sees "Being edited" as soon as the editor starts (or gets the work back with changes)
create or replace function public.work_jobs_deliv_follow() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.delivery is not null and new.status in ('editing', 'rendered', 'changes') and (tg_op = 'INSERT' or new.status is distinct from old.status or new.delivery is distinct from old.delivery) then
    update public.client_deliveries set status = 'editing', job = new.id where id = new.delivery and status = 'waiting';
  end if;
  return null;
end $$;
drop trigger if exists work_jobs_deliv_follow on public.work_jobs;
create trigger work_jobs_deliv_follow after insert or update on public.work_jobs for each row execute function public.work_jobs_deliv_follow();

create or replace function public.job_may_hand(j public.work_jobs) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_staff() or (j.assignee is not null and j.assignee = public.my_person())
$$;

create or replace function public.job_label(j public.work_jobs) returns text language sql immutable as $$
  select coalesce(nullif(trim(j.title), ''), initcap(replace(j.kind, '_', ' '))) || coalesce(' · ' || nullif(trim(j.fn_label), ''), '')
$$;

-- an upload for a job starts here (the Worker then opens a Google Drive upload the browser sends the file to)
create or replace function public.job_upload_begin(p_job uuid, p_name text, p_mime text, p_size bigint) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare j public.work_jobs; n int; id uuid; fname text; ext text;
  stamp text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24.MI');
begin
  select * into j from public.work_jobs where work_jobs.id = p_job;
  if not found then return jsonb_build_object('error', 'Unknown job.'); end if;
  if not public.job_may_hand(j) then return jsonb_build_object('error', 'Only the editor this job is assigned to can hand it over.'); end if;
  if j.status in ('final', 'paused') then return jsonb_build_object('error', 'This job is ' || j.status || '.'); end if;
  if coalesce(p_size, 0) <= 0 then return jsonb_build_object('error', 'The file is empty.'); end if;
  if p_size > 20::bigint * 1024 * 1024 * 1024 then return jsonb_build_object('error', 'Files over 20 GB: put it on Google Drive and hand over the link instead.'); end if;
  if coalesce(p_mime, '') !~ '^[a-z]+/[a-z0-9.+-]+$' then p_mime := 'application/octet-stream'; end if;
  select count(*) into n from public.uploads where by_email = public.my_email() and kind = 'job' and at > now() - interval '1 hour';
  if n >= 40 then return jsonb_build_object('error', 'Too many uploads in one hour. Try again a little later.'); end if;
  ext := coalesce(substring(coalesce(p_name, '') from '(\.[A-Za-z0-9]{1,6})$'), '');
  fname := left(public.job_label(j), 120) || ' · round ' || j.round || ' · ' || stamp || ext;
  insert into public.uploads (kind, purpose, wedding_key, job, name, mime, size, note, by_email, by_person)
  values ('job', 'delivery', j.wedding_key, j.id, left(fname, 200), p_mime, p_size, nullif(left(coalesce(p_name, ''), 300), ''), public.my_email(), public.my_person())
  returning uploads.id into id;
  return jsonb_build_object('id', id, 'folder', to_jsonb(array['Families', left(regexp_replace(j.wedding_title, '[/\\]', '-', 'g'), 100), 'Deliveries']), 'name', fname);
end $$;
revoke all on function public.job_upload_begin(uuid, text, text, bigint) from public, anon;
grant execute on function public.job_upload_begin(uuid, text, text, bigint) to authenticated;

-- a job's uploaded file (for the Worker's preview): the editor of that job or the admin / manager
create or replace function public.job_file(p_upload uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare u public.uploads; j public.work_jobs;
begin
  select * into u from public.uploads where uploads.id = p_upload and kind = 'job' and status = 'ok' and removed_at is null;
  if not found then return jsonb_build_object('error', 'Not found.'); end if;
  select * into j from public.work_jobs where work_jobs.id = u.job;
  if not (public.is_staff() or (j.id is not null and public.job_may_hand(j))) then return jsonb_build_object('error', 'Not found.'); end if;
  return jsonb_build_object('drive_id', u.drive_id, 'mime', u.mime, 'name', u.name, 'size', u.size);
end $$;
revoke all on function public.job_file(uuid) from public, anon;
grant execute on function public.job_file(uuid) to authenticated;

-- the editor hands over: an uploaded file or a link; the job waits for the admin / manager
create or replace function public.job_handover(p_job uuid, p_link text, p_upload uuid, p_note text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare j public.work_jobs; u public.uploads; d uuid; n int; lnk text := nullif(trim(coalesce(p_link, '')), '');
begin
  select * into j from public.work_jobs where id = p_job for update;
  if not found then return jsonb_build_object('error', 'Unknown job.'); end if;
  if not public.job_may_hand(j) then return jsonb_build_object('error', 'Only the editor this job is assigned to can hand it over.'); end if;
  if j.status in ('final', 'paused', 'sent') then return jsonb_build_object('error', case j.status when 'sent' then 'This job was already sent to the family. Muto''s marks "Changes" if more is needed.' else 'This job is ' || j.status || '.' end); end if;
  if p_upload is not null then
    select * into u from public.uploads where id = p_upload and kind = 'job' and job = p_job and status = 'ok' and removed_at is null;
    if not found then return jsonb_build_object('error', 'The upload is not finished.'); end if;
  elsif lnk is null or lnk !~* '^https?://' or length(lnk) > 500 then
    return jsonb_build_object('error', 'Upload the file or paste a link that starts with https://');
  end if;
  -- not linked to the family's delivery yet: the one line with the same name, if there is exactly one
  d := j.delivery;
  if d is null then
    select count(*), min(cd.id::text)::uuid into n, d from public.client_deliveries cd
     where cd.wedding_key = j.wedding_key and lower(trim(cd.title)) in (lower(trim(public.job_label(j))), lower(trim(coalesce(j.title, ''))));
    if n <> 1 then d := null; end if;
  end if;
  perform set_config('mutos.hand', '1', true);
  update public.work_jobs set status = 'rendered', link = case when p_upload is null then lnk else link end, delivery = d,
         hand_upload = p_upload, hand_note = nullif(left(trim(coalesce(p_note, '')), 300), ''), hand_at = now(), hand_by = public.my_email(),
         review = 'waiting', review_note = null, reviewed_by = null, reviewed_at = null
   where id = p_job;
  perform set_config('mutos.hand', '', true);
  return jsonb_build_object('ok', true, 'delivery', d);
end $$;
revoke all on function public.job_handover(uuid, text, uuid, text) from public, anon;
grant execute on function public.job_handover(uuid, text, uuid, text) to authenticated;

-- the admin / manager: approve (→ the family's delivery line is Ready with the link) or ask for changes
create or replace function public.job_review(p_job uuid, p_ok boolean, p_note text, p_link text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare j public.work_jobs; lnk text; dl public.client_deliveries;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can approve work.'); end if;
  select * into j from public.work_jobs where id = p_job for update;
  if not found then return jsonb_build_object('error', 'Unknown job.'); end if;
  if j.review is distinct from 'waiting' then return jsonb_build_object('error', 'Nothing is waiting for a check on this job.'); end if;
  perform set_config('mutos.hand', '1', true);
  if not p_ok then
    if length(trim(coalesce(p_note, ''))) < 3 then perform set_config('mutos.hand', '', true); return jsonb_build_object('error', 'Write what needs to change for the editor.'); end if;
    update public.work_jobs set status = 'changes', review = 'changes', review_note = left(trim(p_note), 300), reviewed_by = public.my_email(), reviewed_at = now() where id = p_job;
    perform set_config('mutos.hand', '', true);
    return jsonb_build_object('ok', true, 'changes', true);
  end if;
  lnk := coalesce(nullif(trim(coalesce(p_link, '')), ''), case when j.hand_upload is null then j.link end);
  if j.delivery is not null and (lnk is null or lnk !~* '^https?://') then
    perform set_config('mutos.hand', '', true);
    return jsonb_build_object('error', case when j.hand_upload is not null then 'The file could not be shared from Google Drive. Try again.' else 'The editor''s link is missing.' end);
  end if;
  update public.work_jobs set status = 'sent', review = 'approved', review_note = nullif(left(trim(coalesce(p_note, '')), 300), ''),
         reviewed_by = public.my_email(), reviewed_at = now() where id = p_job;
  perform set_config('mutos.hand', '', true);
  if j.delivery is not null then
    update public.client_deliveries set status = 'ready', link = left(lnk, 600), job = j.id, upload = j.hand_upload, shared = j.hand_upload is not null
     where id = j.delivery returning * into dl;
  end if;
  return jsonb_build_object('ok', true, 'delivery', dl.id, 'title', dl.title, 'wedding_key', j.wedding_key);
end $$;
revoke all on function public.job_review(uuid, boolean, text, text) from public, anon;
grant execute on function public.job_review(uuid, boolean, text, text) to authenticated;

-- Muto's app · Supervisor login (10 Nov 2026, Ravi). Run once, after 011_no_lock.sql.
--
-- A supervisor:
--   • adds new shoots (no crew or gear on them: that stays with the owner and the partner/manager)
--   • on existing shoots changes only the itinerary and the client's contact: name, date, slot, report time,
--     location, map link, client name and phone, notes (EVENT_EDIT_FIELDS below; same list in public/supervisor.js)
--   • never deletes a shoot, except one he added himself in the last hour (a mistake)
--   • Clients window without money: family Gmails, WhatsApp link, their answers, and he can edit the family's form
--   • Work desk: jobs (assign, update; no deleting), reports, month, drives (view)
--   • no packages, payments, shooter rates, gear desk, people register, attendance, logins or backups
-- Every rule is enforced here; the screens only hide what he cannot use.

alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check
  check (role in ('owner', 'manager', 'crew', 'gear', 'staff', 'accountant', 'kiosk', 'supervisor'));

create or replace function public.is_supervisor() returns boolean
  language sql stable as $$ select coalesce(public.my_role() = 'supervisor', false) $$;
-- the Work desk: owner, manager and supervisor
create or replace function public.is_desk() returns boolean
  language sql stable as $$ select public.is_staff() or public.is_supervisor() $$;

-- ══ BOARD RECORDS ═══════════════════════════════════════════════════════
-- who added each record and when (for "delete his own new shoot within the hour"); existing rows stay empty
alter table public.docs add column if not exists created_by text;
alter table public.docs add column if not exists created_at timestamptz;
create or replace function public.docs_stamp() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.created_by := nullif(public.my_email(), ''); new.created_at := now();
  else new.created_by := old.created_by; new.created_at := old.created_at; end if;   -- nobody can rewrite them
  return new;
end $$;
drop trigger if exists docs_stamp on public.docs;
create trigger docs_stamp before insert or update on public.docs for each row execute function public.docs_stamp();

create or replace function public.event_edit_fields() returns text[] language sql immutable as $$
  select array['name', 'date', 'slot', 'callTime', 'location', 'mapLink', 'contactName', 'contactPhone', 'notes', 'noteSent'] $$;

create or replace function public.docs_supervisor_rules() returns trigger language plpgsql as $$
begin
  if not public.is_supervisor() then return new; end if;
  if new.collection <> 'events' then return new; end if;     -- the policies allow him only events and history
  if tg_op = 'INSERT' then
    -- an upsert of an existing shoot arrives here first; the UPDATE rule below checks it
    if exists (select 1 from public.docs where collection = new.collection and id = new.id) then return new; end if;
    if exists (select 1 from jsonb_array_elements(case when jsonb_typeof(new.data -> 'assignments') = 'array' then new.data -> 'assignments' else '[]'::jsonb end) a
               where coalesce(a ->> 'memberId', '') <> '' or (jsonb_typeof(a -> 'gearIds') = 'array' and jsonb_array_length(a -> 'gearIds') > 0))
       or (jsonb_typeof(new.data -> 'equipmentIds') = 'array' and jsonb_array_length(new.data -> 'equipmentIds') > 0)
       or (jsonb_typeof(new.data -> 'assistantIds') = 'array' and jsonb_array_length(new.data -> 'assistantIds') > 0) then
      raise exception 'A supervisor adds shoots without crew or gear: the admin or manager assigns them.';
    end if;
  else
    if (old.data - public.event_edit_fields()) is distinct from (new.data - public.event_edit_fields()) then
      raise exception 'A supervisor can change only the itinerary and the client''s contact (name, date, slot, report time, place, map, client, notes).';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists docs_supervisor_rules on public.docs;
create trigger docs_supervisor_rules before insert or update on public.docs for each row execute function public.docs_supervisor_rules();

-- How the supervisor's board saves a shoot. An existing shoot takes ONLY his itinerary/contact fields; everything else stays
-- exactly as stored (older shoots may be stored in an older layout, which the board tidies when it saves: a whole-record
-- update would look like other changes and be refused). A new shoot goes in as sent (the rule above refuses crew or gear).
create or replace function public.sup_save_event(p_id text, p_data jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare f text[] := public.event_edit_fields(); patch jsonb; gone text[];
begin
  if not public.is_supervisor() then return jsonb_build_object('error', 'Only for the supervisor login.'); end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 200000 then return jsonb_build_object('error', 'Not a shoot.'); end if;
  if exists (select 1 from public.docs where collection = 'events' and id = p_id) then
    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into patch from jsonb_each(p_data) e(k, v) where k = any(f);
    select coalesce(array_agg(k), '{}') into gone from unnest(f) k where not (p_data ? k);   -- e.g. noteSent cleared when the notes change
    update public.docs set data = (data - gone) || patch where collection = 'events' and id = p_id;
  else
    insert into public.docs (collection, id, data) values ('events', p_id, p_data);
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.sup_save_event(text, jsonb) from public, anon;
grant execute on function public.sup_save_event(text, jsonb) to authenticated;

drop policy if exists docs_sup_select on public.docs;
create policy docs_sup_select on public.docs for select to authenticated using (public.is_supervisor());
drop policy if exists docs_sup_insert on public.docs;
create policy docs_sup_insert on public.docs for insert to authenticated with check (public.is_supervisor() and collection in ('events', 'history'));
drop policy if exists docs_sup_update on public.docs;
create policy docs_sup_update on public.docs for update to authenticated
  using (public.is_supervisor() and collection = 'events') with check (public.is_supervisor() and collection = 'events');
drop policy if exists docs_sup_delete on public.docs;
create policy docs_sup_delete on public.docs for delete to authenticated
  using (public.is_supervisor() and collection = 'events' and created_by = public.my_email() and created_at > now() - interval '1 hour');

-- crew pages and the gear desk follow the board: his date or venue changes reach the crew (he cannot remove pages)
drop policy if exists feed_sup_select on public.crew_feed;
create policy feed_sup_select on public.crew_feed for select to authenticated using (public.is_supervisor());
drop policy if exists feed_sup_insert on public.crew_feed;
create policy feed_sup_insert on public.crew_feed for insert to authenticated with check (public.is_supervisor());
drop policy if exists feed_sup_update on public.crew_feed;
create policy feed_sup_update on public.crew_feed for update to authenticated using (public.is_supervisor()) with check (public.is_supervisor());
drop policy if exists gfeed_sup_select on public.gear_feed;
create policy gfeed_sup_select on public.gear_feed for select to authenticated using (public.is_supervisor());
drop policy if exists gfeed_sup_insert on public.gear_feed;
create policy gfeed_sup_insert on public.gear_feed for insert to authenticated with check (public.is_supervisor());
drop policy if exists gfeed_sup_update on public.gear_feed;
create policy gfeed_sup_update on public.gear_feed for update to authenticated using (public.is_supervisor()) with check (public.is_supervisor());

-- ══ CLIENTS (no money) ══════════════════════════════════════════════════
drop policy if exists clinks_sup_select on public.client_links;
create policy clinks_sup_select on public.client_links for select to authenticated using (public.is_supervisor());
drop policy if exists clinks_sup_insert on public.client_links;
create policy clinks_sup_insert on public.client_links for insert to authenticated with check (public.is_supervisor());
drop policy if exists clinks_sup_update on public.client_links;
create policy clinks_sup_update on public.client_links for update to authenticated using (public.is_supervisor()) with check (public.is_supervisor());
drop policy if exists cfeed_sup_select on public.client_feed;
create policy cfeed_sup_select on public.client_feed for select to authenticated using (public.is_supervisor());
drop policy if exists cfeed_sup_insert on public.client_feed;
create policy cfeed_sup_insert on public.client_feed for insert to authenticated with check (public.is_supervisor());
drop policy if exists cfeed_sup_update on public.client_feed;
create policy cfeed_sup_update on public.client_feed for update to authenticated using (public.is_supervisor()) with check (public.is_supervisor());
drop policy if exists citin_sup_select on public.client_itinerary;
create policy citin_sup_select on public.client_itinerary for select to authenticated using (public.is_supervisor());
drop policy if exists citin_sup_update on public.client_itinerary;
create policy citin_sup_update on public.client_itinerary for update to authenticated using (public.is_supervisor()) with check (public.is_supervisor());

-- who last changed the family's form (a family Gmail, or someone at the studio editing for them)
alter table public.client_itinerary add column if not exists updated_by text;

-- the client page: the studio (owner, manager, supervisor) opens it as the family sees it and can edit it for them.
-- Money (booking) still only for the family, the owner/manager and the accountant (booking_summary decides).
create or replace function public.client_get(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; f jsonb; i public.client_itinerary; fam boolean;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  fam := public.my_email() <> '' and public.my_email() = any(l.emails);
  if not (fam or public.is_desk()) then
    return jsonb_build_object('error', 'This Gmail (' || coalesce(nullif(public.my_email(), ''), 'not signed in') || ') is not on Muto''s list for this wedding.', 'not_listed', true);
  end if;
  select data into f from public.client_feed where wedding_key = l.wedding_key;
  select * into i from public.client_itinerary where wedding_key = l.wedding_key;
  return jsonb_build_object('title', l.title, 'functions', coalesce(f -> 'functions', '[]'::jsonb), 'answers', coalesce(i.data, '{}'::jsonb), 'submitted_at', i.submitted_at,
    'preview', not fam, 'studio_edit', not fam, 'updated_by', i.updated_by, 'updated_at', i.updated_at, 'booking', public.booking_summary(l.wedding_key));
end $$;

create or replace function public.client_save(p_token uuid, p_data jsonb, p_submit boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare l public.client_links; fam boolean;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  fam := public.my_email() <> '' and public.my_email() = any(l.emails);
  if not (fam or public.is_desk()) then return jsonb_build_object('error', 'Only the family''s registered Gmail can fill this in.'); end if;
  -- room for small photos of the family's important people (each photo is shrunk on the phone first)
  if p_data is null or jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 1500000 then return jsonb_build_object('error', 'Too much to save. Remove a few photos or shorten the notes.'); end if;
  insert into public.client_itinerary as c (wedding_key, data, submitted_at, updated_at, updated_by)
  values (l.wedding_key, p_data, case when p_submit and fam then now() end, now(), public.my_email())
  on conflict (wedding_key) do update set data = excluded.data, updated_at = now(), updated_by = public.my_email(),
    submitted_at = case when p_submit and fam then now() else c.submitted_at end;   -- only the family "sends" it
  return jsonb_build_object('ok', true, 'saved_at', now());
end $$;
revoke all on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean) from public, anon;
grant execute on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean) to authenticated;

-- ══ WORK DESK ═══════════════════════════════════════════════════════════
drop policy if exists people_sup_select on public.people;
create policy people_sup_select on public.people for select to authenticated using (public.is_supervisor());
create or replace function public.people_directory() returns table (id uuid, code text, name text, keeper boolean)
  language sql stable security definer set search_path = public as $$
  select p.id, p.code, p.name, 'data' = any(p.skills) from public.people p
  where p.active and (public.is_desk() or public.my_person() is not null) order by p.name $$;

drop policy if exists jobs_sup_select on public.work_jobs;
create policy jobs_sup_select on public.work_jobs for select to authenticated using (public.is_supervisor());
drop policy if exists jobs_sup_insert on public.work_jobs;
create policy jobs_sup_insert on public.work_jobs for insert to authenticated with check (public.is_supervisor());
drop policy if exists jobs_sup_update on public.work_jobs;
create policy jobs_sup_update on public.work_jobs for update to authenticated using (public.is_supervisor()) with check (public.is_supervisor());
-- (no delete policy for him: jobs are removed by the owner or manager)

-- same rules as 007, with the supervisor on the studio side
create or replace function public.work_job_rules() returns trigger language plpgsql as $$
begin
  if not public.is_desk() then
    if row(new.wedding_key, new.wedding_title, new.wedding_date, new.event_ids, new.fn_label, new.kind, new.title, new.assignee, new.due, new.round, new.count_total, new.created_by)
       is distinct from row(old.wedding_key, old.wedding_title, old.wedding_date, old.event_ids, old.fn_label, old.kind, old.title, old.assignee, old.due, old.round, old.count_total, old.created_by) then
      raise exception 'Only the studio can change who does a job, its due date or what it is.';
    end if;
    if new.status is distinct from old.status and not (new.status in ('editing', 'rendered') and old.status in ('todo', 'editing', 'rendered', 'changes')) then
      raise exception 'You can mark a job as Editing or Rendered. Sent, Changes and Final are marked by the studio.';
    end if;
  elsif tg_op = 'UPDATE' and new.status = 'changes' and old.status <> 'changes' and new.round = old.round then
    new.round := least(old.round + 1, 50);      -- the client asked for changes: next round of the same job
  end if;
  if new.status = 'rendered' and new.kind not in ('top', 'lr', 'album_sel') then new.progress := 100; end if;
  if new.status in ('editing', 'rendered') and new.started_at is null then new.started_at := now(); end if;
  if new.status = 'final' and (tg_op = 'INSERT' or old.status <> 'final') then new.done_at := now(); end if;
  if new.status <> 'final' then new.done_at := null; end if;
  new.updated_at := now();
  return new;
end $$;

drop policy if exists rep_sup_select on public.work_reports;
create policy rep_sup_select on public.work_reports for select to authenticated using (public.is_supervisor());

-- drives: he sees the register; giving and taking work as for anyone on People (if he is on it)
drop policy if exists drives_sup_select on public.drives;
create policy drives_sup_select on public.drives for select to authenticated using (public.is_supervisor());
drop policy if exists ditems_sup_select on public.drive_items;
create policy ditems_sup_select on public.drive_items for select to authenticated using (public.is_supervisor());
drop policy if exists dmoves_sup_select on public.drive_moves;
create policy dmoves_sup_select on public.drive_moves for select to authenticated using (public.is_supervisor());
drop policy if exists dlog_sup_select on public.drive_log;
create policy dlog_sup_select on public.drive_log for select to authenticated using (public.is_supervisor());

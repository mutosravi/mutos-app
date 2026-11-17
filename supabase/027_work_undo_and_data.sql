-- 027 (17 Nov 2026, Ravi): run after 026.
--  1. "Work status clicked accidentally, no option of correction in work status by employees."
--     The job remembers its status before the last change and who made it. The person who changed it can put it back
--     (Start tapped by mistake → back to To do / Changes asked; Rendered tapped by mistake → back to Editing) within 24 hours,
--     as long as the studio has not changed it since. Everything else stays as in 007/012.
--  2. "Data location should be visible to any employee to whom a specific client's job has been assigned."
--     job_data(job) lists every drive line of that client's wedding (and older lines typed with the wedding name in the title)
--     with the drive, what is on it and where the drive is now: for the person the job is assigned to, and the studio desk.

alter table public.work_jobs add column if not exists prev_status text;
alter table public.work_jobs add column if not exists status_by text;
alter table public.work_jobs add column if not exists status_at timestamptz;

create or replace function public.work_job_rules() returns trigger language plpgsql as $$
declare undo boolean := false;
begin
  if not public.is_desk() then
    if row(new.wedding_key, new.wedding_title, new.wedding_date, new.event_ids, new.fn_label, new.kind, new.title, new.assignee, new.due, new.round, new.count_total, new.created_by)
       is distinct from row(old.wedding_key, old.wedding_title, old.wedding_date, old.event_ids, old.fn_label, old.kind, old.title, old.assignee, old.due, old.round, old.count_total, old.created_by) then
      raise exception 'Only the studio can change who does a job, its due date or what it is.';
    end if;
    -- putting back a status tapped by mistake: only your own last change, within 24 hours
    undo := new.status is distinct from old.status and new.status = old.prev_status and old.status_by = public.my_email()
            and old.status_at > now() - interval '24 hours' and old.prev_status in ('todo', 'editing', 'changes') and old.status in ('editing', 'rendered');
    if new.status is distinct from old.status and not undo and not (new.status in ('editing', 'rendered') and old.status in ('todo', 'editing', 'rendered', 'changes')) then
      raise exception 'You can mark a job as Editing or Rendered (or undo your own last change). Sent, Changes and Final are marked by the studio.';
    end if;
  elsif tg_op = 'UPDATE' and new.status = 'changes' and old.status <> 'changes' and new.round = old.round then
    new.round := least(old.round + 1, 50);      -- the client asked for changes: next round of the same job
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if undo then
      new.prev_status := null; new.status_by := null; new.status_at := null;    -- one step back only
      if new.status = 'todo' and old.prev_status = 'todo' and old.started_at > now() - interval '24 hours' then new.started_at := null; end if;
    else
      new.prev_status := old.status; new.status_by := public.my_email(); new.status_at := now();
    end if;
  elsif tg_op = 'INSERT' then
    new.prev_status := null; new.status_by := null; new.status_at := null;
  else
    new.prev_status := old.prev_status; new.status_by := old.status_by; new.status_at := old.status_at;   -- nobody writes these by hand
  end if;
  if new.status = 'rendered' and new.kind not in ('top', 'lr', 'album_sel') then new.progress := 100; end if;
  if new.status in ('editing', 'rendered') and new.started_at is null then new.started_at := now(); end if;
  if new.status = 'final' and (tg_op = 'INSERT' or old.status <> 'final') then new.done_at := now(); end if;
  if new.status <> 'final' then new.done_at := null; end if;
  new.updated_at := now();
  return new;
end $$;

-- where a job's footage and files are: every drive line of that wedding
create or replace function public.job_data(p_job uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare j public.work_jobs;
begin
  select * into j from public.work_jobs where id = p_job;
  if not found then return jsonb_build_object('error', 'Unknown job.'); end if;
  if not (public.is_desk() or (j.assignee is not null and j.assignee = public.my_person())) then
    return jsonb_build_object('error', 'Only the person this job is assigned to can see where its data is.');
  end if;
  return jsonb_build_object('wedding', j.wedding_title, 'lines', coalesce((
    select jsonb_agg(jsonb_build_object('title', i.title, 'what', i.what, 'size', i.size_label, 'note', i.note,
             'drive', d.name, 'drive_kind', d.kind, 'drive_status', d.status,
             'where', case when d.holder is null then 'In the office' else 'With ' || coalesce(p.name, 'someone') end,
             'mine', d.holder is not null and d.holder = public.my_person(), 'added_at', i.added_at)
             order by i.title, case i.what when 'raw' then 1 when 'backup' then 2 when 'project' then 3 when 'render' then 4 when 'final' then 5 else 6 end, d.name)
    from public.drive_items i join public.drives d on d.id = i.drive left join public.people p on p.id = d.holder
    where i.removed_at is null
      and (i.wedding_key = j.wedding_key
           or (i.wedding_key is null and length(trim(coalesce(j.wedding_title, ''))) >= 3 and i.title ilike '%' || trim(j.wedding_title) || '%'))), '[]'::jsonb));
end $$;
revoke all on function public.job_data(uuid) from public, anon;
grant execute on function public.job_data(uuid) to authenticated;

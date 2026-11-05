-- Muto's app · People register + Work desk (decided 6 Nov 2026). Run after 005_client_login.sql.
-- (006 is the phone sign-in, parked on branch wip-phone-otp; this file does not need it.)
--
-- people        everyone who works for Muto's, with an automatic employee code (M001, M002 …); names first, details later
-- people_private address, UPI, ID type + last 4 digits only (never the full Aadhaar/PAN number): owner and accountant, and the person
-- work_jobs     one deliverable of one wedding (Reel, Trailer, LR edit, Album design …), assigned by the owner or a manager (partner)
-- work_reports  what each person did each day (append-only; a person may remove their own entry on the same day)

-- ── people ──────────────────────────────────────────────────────────────
create table if not exists public.people (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^M\d{3,5}$'),
  name       text not null check (length(trim(name)) between 1 and 80),
  title      text check (length(title) <= 200),       -- what they do, e.g. "Video Editor/Cinematographer"
  email      text unique check (email = lower(trim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone      text check (length(phone) <= 20),
  skills     text[] not null default '{}',   -- what they do in post-production: video, photo, album, data
  crew_keys  text[] not null default '{}',   -- their entries on the board's crew list (one person can be Cine and Drone)
  joined     date,
  active     boolean not null default true,
  notes      text check (length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create or replace function public.people_rules() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and (new.code is null or new.code = '') then
    -- next number after the highest code (no gaps when an entry is refused); the unique code stops two at once
    new.code := 'M' || lpad((coalesce((select max(substring(code from 2)::int) from public.people), 0) + 1)::text, 3, '0');
  end if;
  if tg_op = 'UPDATE' and new.code is distinct from old.code then raise exception 'The employee code cannot change.'; end if;
  new.name := trim(new.name);
  if new.email = '' then new.email := null; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists people_rules on public.people;
create trigger people_rules before insert or update on public.people for each row execute function public.people_rules();

create table if not exists public.people_private (
  person     uuid primary key references public.people(id) on delete cascade,
  address    text check (length(address) <= 300),
  upi        text check (length(upi) <= 80),
  id_type    text check (id_type in ('Aadhaar', 'PAN', 'Voter ID', 'Driving licence', 'Passport')),
  id_last4   text check (id_last4 ~ '^[0-9A-Za-z]{4}$'),
  emergency  text check (length(emergency) <= 120),
  updated_at timestamptz not null default now()
);
drop trigger if exists people_private_touch on public.people_private;
create trigger people_private_touch before update on public.people_private for each row execute function public.touch_updated_at();

-- the person row of whoever is signed in
create or replace function public.my_person() returns uuid
  language sql stable security definer set search_path = public as $$
  select id from public.people where email = public.my_email() and public.my_email() <> '' and active limit 1 $$;

-- ── work desk ───────────────────────────────────────────────────────────
create table if not exists public.work_jobs (
  id            uuid primary key default gen_random_uuid(),
  wedding_key   text not null check (length(wedding_key) <= 200),
  wedding_title text not null check (length(wedding_title) <= 120),
  wedding_date  date,
  event_ids     text[] not null default '{}',   -- which functions on the board (empty = the whole wedding)
  fn_label      text check (length(fn_label) <= 120),
  kind          text not null check (kind in ('reel', 'teaser', 'trailer', 'highlight', 'full', 'top', 'lr', 'album_sel', 'album', 'other')),
  title         text check (length(title) <= 120),
  assignee      uuid references public.people(id) on delete set null,
  due           date,
  status        text not null default 'todo' check (status in ('todo', 'editing', 'rendered', 'sent', 'changes', 'final', 'paused')),
  progress      smallint not null default 0 check (progress between 0 and 100),
  count_done    integer not null default 0 check (count_done >= 0),
  count_total   integer check (count_total >= 0),
  round         smallint not null default 1 check (round between 1 and 50),
  drive         text check (length(drive) <= 80),
  render_drive  text check (length(render_drive) <= 80),
  link          text check (length(link) <= 500),
  note          text check (length(note) <= 500),
  created_by    text not null default public.my_email(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  started_at    timestamptz,
  done_at       timestamptz
);
create index if not exists work_jobs_assignee on public.work_jobs (assignee, status);
create index if not exists work_jobs_wedding on public.work_jobs (wedding_key);

-- editors may only move their own job forward (todo → editing → rendered) and fill progress, drives, link and note;
-- assigning, due dates, "sent", "changes asked", "final" and "paused" are for the owner and managers
create or replace function public.work_job_rules() returns trigger language plpgsql as $$
begin
  if not public.is_staff() then
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
drop trigger if exists work_job_rules on public.work_jobs;
create trigger work_job_rules before insert or update on public.work_jobs for each row execute function public.work_job_rules();

create table if not exists public.work_reports (
  id         uuid primary key default gen_random_uuid(),
  day        date not null default ((now() at time zone 'Asia/Kolkata')::date),
  person     uuid not null references public.people(id) on delete cascade,
  job        uuid references public.work_jobs(id) on delete set null,
  progress   smallint check (progress between 0 and 100),
  count      integer check (count >= 0),            -- photos done that day (LR, Top, selection)
  hours      numeric(4, 1) check (hours between 0 and 16),
  note       text check (length(note) <= 500),
  by_email   text not null default public.my_email(),
  at         timestamptz not null default now()
);
create index if not exists work_reports_day on public.work_reports (day, person);

create or replace function public.work_report_rules() returns trigger language plpgsql as $$
declare today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  new.by_email := public.my_email(); new.at := now();
  if not public.is_staff() then
    if new.person is distinct from public.my_person() then raise exception 'You can only write your own report.'; end if;
    if new.day not between today - 1 and today then raise exception 'Reports are for today (or yesterday, if you forgot).'; end if;
    if new.job is not null and not exists (select 1 from public.work_jobs where id = new.job and assignee = new.person) then raise exception 'That job is not yours.'; end if;
  end if;
  if new.job is null and coalesce(trim(new.note), '') = '' then raise exception 'Write what you worked on.'; end if;
  return new;
end $$;
drop trigger if exists work_report_rules on public.work_reports;
create trigger work_report_rules before insert on public.work_reports for each row execute function public.work_report_rules();

-- ── access rules ────────────────────────────────────────────────────────
alter table public.people enable row level security;
alter table public.people_private enable row level security;
alter table public.work_jobs enable row level security;
alter table public.work_reports enable row level security;

drop policy if exists people_select on public.people;
create policy people_select on public.people for select to authenticated using (public.is_staff() or public.is_payroll() or id = public.my_person());
drop policy if exists people_insert on public.people;
create policy people_insert on public.people for insert to authenticated with check (public.is_staff());
drop policy if exists people_update on public.people;
create policy people_update on public.people for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists people_delete on public.people;
create policy people_delete on public.people for delete to authenticated using (public.is_owner());

drop policy if exists pp_select on public.people_private;
create policy pp_select on public.people_private for select to authenticated using (public.is_payroll() or person = public.my_person());
drop policy if exists pp_write on public.people_private;
create policy pp_write on public.people_private for all to authenticated using (public.is_owner() or person = public.my_person()) with check (public.is_owner() or person = public.my_person());

drop policy if exists jobs_select on public.work_jobs;
create policy jobs_select on public.work_jobs for select to authenticated using (public.is_staff() or (assignee is not null and assignee = public.my_person()));
drop policy if exists jobs_insert on public.work_jobs;
create policy jobs_insert on public.work_jobs for insert to authenticated with check (public.is_staff());
drop policy if exists jobs_update on public.work_jobs;
create policy jobs_update on public.work_jobs for update to authenticated
  using (public.is_staff() or (assignee is not null and assignee = public.my_person()))
  with check (public.is_staff() or (assignee is not null and assignee = public.my_person()));
drop policy if exists jobs_delete on public.work_jobs;
create policy jobs_delete on public.work_jobs for delete to authenticated using (public.is_staff());

drop policy if exists rep_select on public.work_reports;
create policy rep_select on public.work_reports for select to authenticated using (public.is_staff() or person = public.my_person());
drop policy if exists rep_insert on public.work_reports;
create policy rep_insert on public.work_reports for insert to authenticated with check (public.is_staff() or person = public.my_person());
drop policy if exists rep_delete on public.work_reports;
create policy rep_delete on public.work_reports for delete to authenticated
  using (public.is_owner() or (person = public.my_person() and day = (now() at time zone 'Asia/Kolkata')::date));

revoke all on public.people, public.people_private, public.work_jobs, public.work_reports from anon;
grant select, insert, update, delete on public.people, public.people_private, public.work_jobs to authenticated;
grant select, insert, delete on public.work_reports to authenticated;

-- live updates for the desk and the editors' page
do $$ begin
  begin alter publication supabase_realtime add table public.work_jobs; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.work_reports; exception when duplicate_object then null; end;
end $$;

-- ── first names: October 2026 salary list (+ Kuldeep, Sandeep from the drive sheet); details are filled in later on the People screen ──
-- each is linked to the board's crew entries with the same name (a person can have several, e.g. Cine and Drone)
insert into public.people (name, title, crew_keys)
select t.n, nullif(t.title, ''),
  coalesce((select array_agg(d.id order by d.id) from public.docs d
            where d.collection = 'shooters' and lower(trim(d.data ->> 'name')) = any(string_to_array(lower(t.crew), '|'))), '{}')
from (values
  (1, 'Shrey', 'Video Editor/Cinematographer/Social media manager', 'shrey'),
  (2, 'Adesh', 'Photo Editor/Cinematographer', 'adesh'),
  (3, 'Aman', 'Video Editor/Cinematographer', 'aman'),
  (4, 'Danish', 'Video Editor/Photo', 'danish'),
  (5, 'Saif', 'Video Editor/Cinematographer', 'saif'),
  (6, 'Imran', 'Photo/Album Designer', 'imran'),
  (7, 'Waseem', 'Video Editor/Cinematographer', 'waseem|vaseem'),
  (8, 'Yuvraj', 'Video Editor', 'yuvraj|yuvraaj'),
  (9, 'Rohan', 'Candid/Album Designer', 'rohan'),
  (10, 'Anurag', 'Assist/Selection & LR Work/Video', 'anurag'),
  (11, 'Shadab', 'Sales / Photo-Video Editor', 'shadab'),
  (12, 'Hamza', 'Video Editor/Photo', 'hamza'),
  (13, 'Badal', 'Video Editor', 'badal'),
  (14, 'Kaka', 'Reception Area Manage/Delivery', 'kaka'),
  (15, 'Kaushal', 'Dusting/Tea/Coffee', 'kaushal'),
  (16, 'Pallavi', 'Sheet & CRM updates/Client follow-ups/Payment reminders', 'pallavi'),
  (17, 'Devyansh', 'Cinematographer', 'devyansh'),
  (18, 'Nitesh', 'Video Editor and Cinematographer', 'nitesh'),
  (19, 'Ankit', 'Video Editor', 'ankit'),
  (20, 'Aditya', 'Photo/Video Editor/Photo Shoot', 'aditya'),
  (21, 'Kuldeep', '', 'kuldeep'),
  (22, 'Sandeep', 'Candid/Album Designer', 'sandeep')
) as t(i, n, title, crew)
where not exists (select 1 from public.people p where lower(p.name) = lower(t.n))
order by t.i;

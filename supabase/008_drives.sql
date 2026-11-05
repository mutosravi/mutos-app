-- Muto's app · Drive register (decided 6 Nov 2026). Run after 007_work_desk.sql.
--
-- drives        every hard drive / SSD / NAS: the studio's and clients' drives; who has it now (holder; empty = in the office)
-- drive_items   what is on each drive (a wedding's raw, project, render …); moving or copying data keeps the old line as history
-- drive_moves   a drive changes hands only when the giver logs it AND the receiver accepts it in the app
-- drive_log     everything that happened to a drive, never edited (for finding data years later)
--
-- Drive keepers = people with the "data" skill (People screen): they look after the drives in the office.

create or replace function public.is_keeper() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.people where id = public.my_person() and 'data' = any(skills)) $$;

-- everyone at Muto's can see names (to pick who gets a drive), but not the rest of the register
create or replace function public.people_directory() returns table (id uuid, code text, name text, keeper boolean)
  language sql stable security definer set search_path = public as $$
  select p.id, p.code, p.name, 'data' = any(p.skills) from public.people p
  where p.active and (public.is_staff() or public.my_person() is not null) order by p.name $$;

-- ── tables ──────────────────────────────────────────────────────────────
create table if not exists public.drives (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 60),
  owner_type  text not null default 'studio' check (owner_type in ('studio', 'client')),
  client_name text check (length(client_name) <= 120),
  kind        text not null default 'HDD' check (kind in ('HDD', 'SSD', 'NAS', 'Card', 'Other')),
  size_label  text check (length(size_label) <= 20),
  model       text check (length(model) <= 60),
  format      text check (length(format) <= 40),
  status      text not null default 'in_use' check (status in ('in_use', 'delivered', 'faulty', 'retired')),
  holder      uuid references public.people(id) on delete set null,   -- empty = in the office
  free_label  text check (length(free_label) <= 20),
  cleaned_on  date,
  notes       text check (length(notes) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists drives_name_uq on public.drives (lower(trim(name)));

create table if not exists public.drive_items (
  id          uuid primary key default gen_random_uuid(),
  drive       uuid not null references public.drives(id) on delete cascade,
  wedding_key text check (length(wedding_key) <= 200),
  title       text not null check (length(trim(title)) between 1 and 160),   -- e.g. "Jyoti & Amit · Haldi"
  what        text not null default 'raw' check (what in ('raw', 'project', 'render', 'final', 'backup', 'other')),
  size_label  text check (length(size_label) <= 20),
  note        text check (length(note) <= 300),
  from_item   uuid references public.drive_items(id) on delete set null,     -- moved or copied from
  added_by    text not null default public.my_email(),
  added_at    timestamptz not null default now(),
  removed_at  timestamptz,
  removed_why text check (removed_why in ('moved', 'cleaned', 'delivered', 'mistake')),
  moved_to    uuid references public.drive_items(id) on delete set null
);
create index if not exists drive_items_drive on public.drive_items (drive) where removed_at is null;
create index if not exists drive_items_wedding on public.drive_items (wedding_key);

create table if not exists public.drive_moves (
  id          uuid primary key default gen_random_uuid(),
  drive       uuid not null references public.drives(id) on delete cascade,
  from_person uuid references public.people(id) on delete set null,     -- empty = from the office
  to_person   uuid references public.people(id) on delete set null,     -- empty = back to the office (a keeper accepts)
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  note        text check (length(note) <= 300),
  given_by    text not null,
  given_by_person uuid references public.people(id) on delete set null,   -- who handed it over (for "given by Kuldeep")
  given_at    timestamptz not null default now(),
  answered_by text,
  answered_at timestamptz
);
create unique index if not exists drive_moves_one_pending on public.drive_moves (drive) where status = 'pending';

create table if not exists public.drive_log (
  id     bigserial primary key,
  drive  uuid references public.drives(id) on delete set null,
  at     timestamptz not null default now(),
  by_email text not null default public.my_email(),
  what   text not null
);
create index if not exists drive_log_drive on public.drive_log (drive, at desc);

-- ── helpers ─────────────────────────────────────────────────────────────
create or replace function public.person_name(p uuid) returns text language sql stable security definer set search_path = public as $$
  select coalesce((select name from public.people where id = p), 'the office') $$;
create or replace function public.drive_note(d uuid, txt text) returns void language sql security definer set search_path = public as $$
  insert into public.drive_log (drive, by_email, what) values (d, public.my_email(), txt) $$;
-- may this person work on this drive's contents? (studio, keepers, whoever has it)
create or replace function public.can_drive(d uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.is_staff() or public.is_keeper() or exists (select 1 from public.drives where id = d and holder is not null and holder = public.my_person()) $$;

-- direct edits are logged by triggers; the functions below write their own lines (and set mutos.quiet)
create or replace function public.drives_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.name := trim(new.name); new.updated_at := now();
  if tg_op = 'UPDATE' and new.holder is distinct from old.holder and coalesce(current_setting('mutos.quiet', true), '') <> '1' then
    raise exception 'A drive changes hands only by giving it in the app and the other person accepting.';
  end if;
  return new;
end $$;
drop trigger if exists drives_trg on public.drives;
create trigger drives_trg before insert or update on public.drives for each row execute function public.drives_trg();

create or replace function public.drives_log_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('mutos.quiet', true), '') = '1' then return null; end if;
  if tg_op = 'INSERT' then perform public.drive_note(new.id, 'Added to the register (' || coalesce(new.size_label || ' ', '') || new.kind || ', ' || case when new.holder is null then 'in the office' else 'with ' || public.person_name(new.holder) end || ')');
  elsif new.status is distinct from old.status then perform public.drive_note(new.id, 'Status: ' || replace(new.status, '_', ' ') || coalesce(' · ' || nullif(new.notes, old.notes), ''));
  elsif new.cleaned_on is distinct from old.cleaned_on then perform public.drive_note(new.id, 'Cleaned on ' || to_char(new.cleaned_on, 'DD Mon YYYY') || coalesce(', free ' || new.free_label, ''));
  elsif row(new.name, new.size_label, new.model, new.kind, new.owner_type, new.client_name) is distinct from row(old.name, old.size_label, old.model, old.kind, old.owner_type, old.client_name) then
    perform public.drive_note(new.id, 'Details changed' || case when new.name <> old.name then ' (was "' || old.name || '")' else '' end);
  end if;
  return null;
end $$;
drop trigger if exists drives_log_trg on public.drives;
create trigger drives_log_trg after insert or update on public.drives for each row execute function public.drives_log_trg();

create or replace function public.drive_items_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if old.removed_at is not null and new.removed_at is null then raise exception 'Removed data stays in the history; add it again instead.'; end if;
    if row(new.drive, new.from_item, new.added_by, new.added_at) is distinct from row(old.drive, old.from_item, old.added_by, old.added_at) then raise exception 'Use Move to put data on another drive.'; end if;
  else
    new.added_by := public.my_email(); new.added_at := now(); new.removed_at := null; new.removed_why := null; new.moved_to := null;
  end if;
  new.title := trim(new.title);
  if coalesce(current_setting('mutos.quiet', true), '') <> '1' then
    if tg_op = 'INSERT' then perform public.drive_note(new.drive, 'Data added: ' || new.title || ' (' || new.what || coalesce(', ' || new.size_label, '') || ')');
    elsif new.removed_at is not null and old.removed_at is null then
      new.removed_why := coalesce(new.removed_why, 'cleaned');
      perform public.drive_note(new.drive, 'Data removed (' || new.removed_why || '): ' || new.title || ' (' || new.what || ')');
    elsif row(new.title, new.what, new.size_label, new.note) is distinct from row(old.title, old.what, old.size_label, old.note) then
      perform public.drive_note(new.drive, 'Data renamed: ' || old.title || ' → ' || new.title);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists drive_items_trg on public.drive_items;
create trigger drive_items_trg before insert or update on public.drive_items for each row execute function public.drive_items_trg();

-- ── handing over: give → accept ─────────────────────────────────────────
create or replace function public.drive_give(p_drive uuid, p_to uuid, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare d public.drives; me uuid := public.my_person(); mid uuid;
begin
  select * into d from public.drives where id = p_drive;
  if not found then return jsonb_build_object('error', 'Unknown drive.'); end if;
  if not (public.is_staff() or (d.holder is null and public.is_keeper()) or (d.holder is not null and d.holder = me)) then
    return jsonb_build_object('error', 'Only the person who has ' || d.name || ' (or the studio) can give it.');
  end if;
  if d.status <> 'in_use' then return jsonb_build_object('error', d.name || ' is marked ' || replace(d.status, '_', ' ') || '.'); end if;
  if p_to is not distinct from d.holder then return jsonb_build_object('error', case when p_to is null then d.name || ' is already in the office.' else public.person_name(p_to) || ' already has ' || d.name || '.' end); end if;
  if p_to is not null and not exists (select 1 from public.people where id = p_to and active) then return jsonb_build_object('error', 'That person is not on the people list.'); end if;
  if length(p_note) > 300 then return jsonb_build_object('error', 'Note too long.'); end if;
  update public.drive_moves set status = 'cancelled', answered_by = public.my_email(), answered_at = now() where drive = p_drive and status = 'pending';
  insert into public.drive_moves (drive, from_person, to_person, note, given_by, given_by_person) values (p_drive, d.holder, p_to, nullif(trim(p_note), ''), public.my_email(), me) returning id into mid;
  perform public.drive_note(p_drive, public.person_name(d.holder) || ' → ' || public.person_name(p_to) || ': given, waiting to be accepted' || coalesce(' (' || nullif(trim(p_note), '') || ')', ''));
  return jsonb_build_object('ok', true, 'id', mid);
end $$;

create or replace function public.drive_answer(p_move uuid, p_accept boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare m public.drive_moves; d public.drives;
begin
  select * into m from public.drive_moves where id = p_move and status = 'pending';
  if not found then return jsonb_build_object('error', 'This handover is no longer waiting.'); end if;
  if not ((m.to_person is not null and m.to_person = public.my_person()) or (m.to_person is null and (public.is_keeper() or public.is_staff()))) then
    return jsonb_build_object('error', 'This handover is not for you.');
  end if;
  select * into d from public.drives where id = m.drive;
  if p_accept and d.holder is distinct from m.from_person then
    update public.drive_moves set status = 'cancelled', answered_by = public.my_email(), answered_at = now() where id = p_move;
    return jsonb_build_object('error', d.name || ' changed hands in the meantime. Ask for it to be given again.');
  end if;
  update public.drive_moves set status = case when p_accept then 'accepted' else 'declined' end, answered_by = public.my_email(), answered_at = now() where id = p_move;
  if p_accept then
    perform set_config('mutos.quiet', '1', true);
    update public.drives set holder = m.to_person where id = m.drive;
    perform set_config('mutos.quiet', '', true);
  end if;
  perform public.drive_note(m.drive, public.person_name(m.to_person) || case when p_accept then ' accepted ' || d.name || ' from ' || public.person_name(m.from_person) || '. Now their responsibility.' else ' did not accept ' || d.name || ' (still with ' || public.person_name(m.from_person) || ')' end);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.drive_cancel(p_move uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare m public.drive_moves;
begin
  select * into m from public.drive_moves where id = p_move and status = 'pending';
  if not found then return jsonb_build_object('error', 'This handover is no longer waiting.'); end if;
  if not (m.given_by = public.my_email() or public.is_staff()) then return jsonb_build_object('error', 'Only the giver can take it back.'); end if;
  update public.drive_moves set status = 'cancelled', answered_by = public.my_email(), answered_at = now() where id = p_move;
  perform public.drive_note(m.drive, 'Handover to ' || public.person_name(m.to_person) || ' cancelled');
  return jsonb_build_object('ok', true);
end $$;

-- the owner can correct where a drive is (e.g. after the first import), with a line in the history
create or replace function public.drive_set_holder(p_drive uuid, p_person uuid, p_why text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare d public.drives;
begin
  if not public.is_owner() then return jsonb_build_object('error', 'Only the owner can correct this.'); end if;
  select * into d from public.drives where id = p_drive; if not found then return jsonb_build_object('error', 'Unknown drive.'); end if;
  update public.drive_moves set status = 'cancelled', answered_by = public.my_email(), answered_at = now() where drive = p_drive and status = 'pending';
  perform set_config('mutos.quiet', '1', true);
  update public.drives set holder = p_person where id = p_drive;
  perform set_config('mutos.quiet', '', true);
  perform public.drive_note(p_drive, 'Corrected by the owner: now with ' || public.person_name(p_person) || coalesce(' (' || nullif(trim(p_why), '') || ')', ''));
  return jsonb_build_object('ok', true);
end $$;

-- ── moving data between drives (the old line stays as history) ──────────
create or replace function public.drive_move_item(p_item uuid, p_to_drive uuid, p_copy boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare it public.drive_items; src public.drives; dst public.drives; nid uuid;
begin
  select * into it from public.drive_items where id = p_item and removed_at is null;
  if not found then return jsonb_build_object('error', 'That data is no longer on the drive.'); end if;
  select * into src from public.drives where id = it.drive; select * into dst from public.drives where id = p_to_drive;
  if dst.id is null then return jsonb_build_object('error', 'Pick the drive to move it to.'); end if;
  if dst.id = src.id then return jsonb_build_object('error', 'That is the same drive.'); end if;
  if dst.status <> 'in_use' then return jsonb_build_object('error', dst.name || ' is marked ' || replace(dst.status, '_', ' ') || '.'); end if;
  if not (public.can_drive(src.id) or public.can_drive(dst.id)) then return jsonb_build_object('error', 'Only the studio, a drive keeper or whoever has the drive can move data.'); end if;
  perform set_config('mutos.quiet', '1', true);
  insert into public.drive_items (drive, wedding_key, title, what, size_label, note, from_item) values (dst.id, it.wedding_key, it.title, it.what, it.size_label, it.note, it.id) returning id into nid;
  if not p_copy then update public.drive_items set removed_at = now(), removed_why = 'moved', moved_to = nid where id = it.id; end if;
  perform set_config('mutos.quiet', '', true);
  perform public.drive_note(src.id, case when p_copy then 'Copied ' else 'Moved ' end || it.title || ' (' || it.what || ') to ' || dst.name);
  perform public.drive_note(dst.id, it.title || ' (' || it.what || ') ' || case when p_copy then 'copied' else 'moved' end || ' here from ' || src.name);
  return jsonb_build_object('ok', true, 'id', nid);
end $$;

-- ── access rules ────────────────────────────────────────────────────────
alter table public.drives enable row level security;
alter table public.drive_items enable row level security;
alter table public.drive_moves enable row level security;
alter table public.drive_log enable row level security;

drop policy if exists drives_select on public.drives;
create policy drives_select on public.drives for select to authenticated using (public.is_staff() or public.my_person() is not null);
drop policy if exists drives_insert on public.drives;
create policy drives_insert on public.drives for insert to authenticated with check (public.is_staff() or public.is_keeper());
drop policy if exists drives_update on public.drives;
create policy drives_update on public.drives for update to authenticated using (public.can_drive(id)) with check (public.can_drive(id));
drop policy if exists drives_delete on public.drives;
create policy drives_delete on public.drives for delete to authenticated using (public.is_owner());

drop policy if exists ditems_select on public.drive_items;
create policy ditems_select on public.drive_items for select to authenticated using (public.is_staff() or public.my_person() is not null);
drop policy if exists ditems_insert on public.drive_items;
create policy ditems_insert on public.drive_items for insert to authenticated with check (public.can_drive(drive));
drop policy if exists ditems_update on public.drive_items;
create policy ditems_update on public.drive_items for update to authenticated using (public.can_drive(drive)) with check (public.can_drive(drive));

drop policy if exists dmoves_select on public.drive_moves;
create policy dmoves_select on public.drive_moves for select to authenticated
  using (public.is_staff() or public.is_keeper() or from_person = public.my_person() or to_person = public.my_person() or given_by = public.my_email());

drop policy if exists dlog_select on public.drive_log;
create policy dlog_select on public.drive_log for select to authenticated using (public.is_staff() or public.my_person() is not null);

revoke all on public.drives, public.drive_items, public.drive_moves, public.drive_log from anon, authenticated;
grant select, insert, delete on public.drives to authenticated;
grant update (name, owner_type, client_name, kind, size_label, model, format, status, free_label, cleaned_on, notes) on public.drives to authenticated;  -- not "holder": only give → accept
grant select, insert on public.drive_items to authenticated;
grant update (title, what, size_label, note, removed_at, removed_why) on public.drive_items to authenticated;
grant select on public.drive_moves, public.drive_log to authenticated;
revoke all on function public.drive_give(uuid, uuid, text), public.drive_answer(uuid, boolean), public.drive_cancel(uuid), public.drive_set_holder(uuid, uuid, text),
  public.drive_move_item(uuid, uuid, boolean), public.people_directory(), public.drive_note(uuid, text) from public, anon;
grant execute on function public.drive_give(uuid, uuid, text), public.drive_answer(uuid, boolean), public.drive_cancel(uuid), public.drive_set_holder(uuid, uuid, text),
  public.drive_move_item(uuid, uuid, boolean), public.people_directory() to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.drive_moves; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.drives; exception when duplicate_object then null; end;
end $$;

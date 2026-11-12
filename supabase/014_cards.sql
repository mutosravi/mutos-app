-- Muto's app · Memory cards (decided 11 Nov 2026, Ravi). Run once, after 013_undo_punch.sql.
--
-- cards       every memory card: code (as written on its label), type, size, brand, serial; who has it now (holder; empty = in the office)
-- card_moves  a card changes hands only when the giver logs it AND the receiver accepts it in the app (several cards at once = one batch)
-- card_uses   the team leader's notes per card: which shoot, photo or video, candid or cine, notes (or "not used")
-- card_copies where the card was copied: drive, folder, number of files; the drive's contents get a line automatically
-- card_log    everything that happened to a card, never edited
--
-- What is on a card (cards.data):
--   empty   nothing to keep on it
--   hold    has footage that is not copied yet: DO NOT FORMAT (red)
--   single  copied once: safe to format, but no backup yet (amber)
--   copied  copied and backed up (green)
-- A card that was single or copied starts a new round ("cycle") when it is handed out again: it will be formatted; the old copy record stays.
--
-- Who does what (Ravi, 11 Nov):
--   owner, manager, supervisor   give cards out and accept them back (the supervisor is the bridge when the office is away)
--   team leaders (anyone on People)  accept cards, write notes per card, pass cards to the supervisor, the office or another team leader
--   ONLY owner and manager       mark a card copied (first copy, then backup)
-- No formatting step in the app: amber or green already says "safe to format".

create or replace function public.is_card_desk() returns boolean
  language sql stable as $$ select public.is_staff() or public.is_supervisor() $$;

-- ── tables ──────────────────────────────────────────────────────────────
create table if not exists public.cards (
  id          uuid primary key default gen_random_uuid(),
  code        text not null check (length(trim(code)) between 1 and 30),
  kind        text not null default 'SD' check (kind in ('CFexpress A', 'CFexpress B', 'SD', 'microSD', 'XQD', 'CFast', 'Other')),
  size_label  text check (length(size_label) <= 20),
  brand       text check (length(brand) <= 60),
  serial      text check (length(serial) <= 80),
  notes       text check (length(notes) <= 300),
  holder      uuid references public.people(id) on delete set null,   -- empty = in the office
  data        text not null default 'empty' check (data in ('empty', 'hold', 'single', 'copied')),
  data_since  timestamptz,                                          -- when it went on hold (for "on hold too long")
  condition   text not null default 'ok' check (condition in ('ok', 'damaged', 'lost', 'retired')),
  errors      int not null default 0,
  cycle       int not null default 1,
  with_team   boolean not null default false,                      -- went to a team in this round (so it cannot come back unnoted)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists cards_code_uq on public.cards (lower(trim(code)));
create unique index if not exists cards_serial_uq on public.cards (lower(trim(serial))) where coalesce(trim(serial), '') <> '';

create table if not exists public.card_moves (
  id          uuid primary key default gen_random_uuid(),
  card        uuid not null references public.cards(id) on delete cascade,
  batch       uuid not null,
  from_person uuid references public.people(id) on delete set null,   -- empty = from the office
  to_person   uuid references public.people(id) on delete set null,   -- empty = back to the office (owner or manager accepts)
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  note        text check (length(note) <= 300),
  given_by    text not null,
  given_by_person uuid references public.people(id) on delete set null,
  given_at    timestamptz not null default now(),
  answered_by text,
  answered_at timestamptz
);
create unique index if not exists card_moves_one_pending on public.card_moves (card) where status = 'pending';
create index if not exists card_moves_batch on public.card_moves (batch);

create table if not exists public.card_uses (
  id        uuid primary key default gen_random_uuid(),
  card      uuid not null references public.cards(id) on delete cascade,
  cycle     int not null,
  used      boolean not null default true,
  event_id  text check (length(event_id) <= 100),   -- the board's shoot id
  shoot     text check (length(shoot) <= 160),       -- e.g. "Sharma Haldi"
  wedding   text check (length(wedding) <= 160),
  media     text check (media in ('photo', 'video', 'both')),
  style     text check (style in ('candid', 'cine', 'traditional', 'drone', 'other')),
  camera    text check (length(camera) <= 60),
  note      text check (length(note) <= 300),
  by_email  text not null,
  by_person uuid references public.people(id) on delete set null,
  at        timestamptz not null default now()
);
create index if not exists card_uses_card on public.card_uses (card, cycle);

create table if not exists public.card_copies (
  id         uuid primary key default gen_random_uuid(),
  card       uuid not null references public.cards(id) on delete cascade,
  cycle      int not null,
  backup     boolean not null default false,
  drive      uuid references public.drives(id) on delete set null,
  drive_name text not null,
  folder     text check (length(folder) <= 200),
  files      int not null check (files > 0),
  size_label text check (length(size_label) <= 20),
  items      uuid[] not null default '{}',             -- the lines added to the drive's contents
  by_email   text not null,
  at         timestamptz not null default now()
);
create index if not exists card_copies_card on public.card_copies (card, cycle);

create table if not exists public.card_log (
  id       bigserial primary key,
  card     uuid references public.cards(id) on delete set null,
  at       timestamptz not null default now(),
  by_email text not null default public.my_email(),
  what     text not null
);
create index if not exists card_log_card on public.card_log (card, at desc);

-- ── helpers and triggers ────────────────────────────────────────────────
create or replace function public.card_note(cd uuid, txt text) returns void language sql security definer set search_path = public as $$
  insert into public.card_log (card, by_email, what) values (cd, public.my_email(), txt) $$;
-- is this person one of the desk (owner, manager, supervisor)? used to know when a card went to a team
create or replace function public.person_is_desk(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.people pp join public.members m on m.email = pp.email where pp.id = p and m.role in ('owner', 'manager', 'supervisor')) $$;

-- holder, data, condition, errors, cycle change only through the functions below (they set mutos.quiet)
create or replace function public.cards_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.code := trim(new.code); new.serial := nullif(trim(coalesce(new.serial, '')), ''); new.updated_at := now();
  if coalesce(current_setting('mutos.quiet', true), '') <> '1' then
    if tg_op = 'INSERT' then
      new.holder := null; new.data := 'empty'; new.data_since := null; new.condition := 'ok'; new.errors := 0; new.cycle := 1; new.with_team := false;
    elsif row(new.holder, new.data, new.condition, new.errors, new.cycle, new.with_team) is distinct from row(old.holder, old.data, old.condition, old.errors, old.cycle, old.with_team) then
      raise exception 'A card changes hands, status or copies only through the app''s buttons.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists cards_trg on public.cards;
create trigger cards_trg before insert or update on public.cards for each row execute function public.cards_trg();

create or replace function public.cards_log_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('mutos.quiet', true), '') = '1' then return null; end if;
  if tg_op = 'INSERT' then perform public.card_note(new.id, 'Added to the register (' || concat_ws(' ', new.size_label, new.kind, new.brand) || coalesce(', serial ' || new.serial, '') || ')');
  else perform public.card_note(new.id, 'Details changed' || case when new.code <> old.code then ' (was "' || old.code || '")' else '' end); end if;
  return null;
end $$;
drop trigger if exists cards_log_trg on public.cards;
create trigger cards_log_trg after insert or update on public.cards for each row execute function public.cards_log_trg();

-- ── handing over: give → accept (one or many cards) ─────────────────────
create or replace function public.card_give(p_cards uuid[], p_to uuid, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare k public.cards; me uuid := public.my_person(); b uuid := gen_random_uuid(); n int := 0; warn text[] := '{}';
begin
  if coalesce(array_length(p_cards, 1), 0) = 0 then return jsonb_build_object('error', 'Pick the cards to give.'); end if;
  if p_to is not null and not exists (select 1 from public.people where id = p_to and active) then return jsonb_build_object('error', 'That person is not on the People list.'); end if;
  if length(p_note) > 300 then return jsonb_build_object('error', 'Note too long.'); end if;
  for k in select * from public.cards where id = any(p_cards) order by code loop
    if not ((k.holder is null and public.is_card_desk()) or (k.holder is not null and k.holder = me) or (k.holder is not null and public.is_staff())) then
      return jsonb_build_object('error', 'Only whoever has ' || k.code || ' (or the office) can give it.');
    end if;
    if k.condition <> 'ok' then return jsonb_build_object('error', k.code || ' is marked ' || k.condition || '.'); end if;
    if p_to is not distinct from k.holder then return jsonb_build_object('error', case when p_to is null then k.code || ' is already in the office.' else public.person_name(p_to) || ' already has ' || k.code || '.' end); end if;
    if k.holder is null and k.data = 'hold' then return jsonb_build_object('error', k.code || ' has footage that is not copied yet. Copy it before giving it out.'); end if;
    if k.data = 'single' and k.holder is null then warn := warn || k.code; end if;
    update public.card_moves set status = 'cancelled', answered_by = public.my_email(), answered_at = now() where card = k.id and status = 'pending';
    insert into public.card_moves (card, batch, from_person, to_person, note, given_by, given_by_person) values (k.id, b, k.holder, p_to, nullif(trim(p_note), ''), public.my_email(), me);
    perform public.card_note(k.id, public.person_name(k.holder) || ' → ' || public.person_name(p_to) || ': given, waiting to be accepted' || coalesce(' (' || nullif(trim(p_note), '') || ')', ''));
    n := n + 1;
  end loop;
  if n <> array_length(p_cards, 1) then raise exception 'Unknown card in the list.'; end if;
  return jsonb_build_object('ok', true, 'batch', b, 'count', n, 'single_copy', to_jsonb(warn));
end $$;

create or replace function public.card_answer(p_moves uuid[], p_accept boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare m public.card_moves; k public.cards; n int := 0; why text;
begin
  for m in select * from public.card_moves where id = any(p_moves) and status = 'pending' loop
    if not ((m.to_person is not null and m.to_person = public.my_person()) or (m.to_person is null and public.is_staff())) then
      return jsonb_build_object('error', 'This handover is not for you.');
    end if;
    select * into k from public.cards where id = m.card;
    if p_accept and k.holder is distinct from m.from_person then
      update public.card_moves set status = 'cancelled', answered_by = public.my_email(), answered_at = now() where id = m.id;
      perform public.card_note(k.id, 'Handover cancelled: ' || k.code || ' changed hands in the meantime');
      continue;
    end if;
    update public.card_moves set status = case when p_accept then 'accepted' else 'declined' end, answered_by = public.my_email(), answered_at = now() where id = m.id;
    if p_accept then
      why := null;
      perform set_config('mutos.quiet', '1', true);
      -- leaving the office after being copied: it will be formatted, so a new round starts (the old copies stay in the history)
      if m.from_person is null and k.data in ('single', 'copied') then
        update public.cards set data = 'empty', data_since = null, cycle = cycle + 1, with_team = false where id = k.id;
        why := ' Old footage was already copied (' || case when k.data = 'single' then 'single copy' else 'with backup' end || '), so it can be formatted.';
        select * into k from public.cards where id = k.id;
      end if;
      update public.cards set holder = m.to_person, with_team = with_team or (m.to_person is not null and not public.person_is_desk(m.to_person)) where id = k.id;
      select * into k from public.cards where id = k.id;
      -- back in the office from a team with no notes at all: keep it on hold until someone checks it
      if m.to_person is null and k.data = 'empty' and k.with_team and not exists (select 1 from public.card_uses where card = k.id and cycle = k.cycle) then
        update public.cards set data = 'hold', data_since = now() where id = k.id;
        why := coalesce(why, '') || ' Came back without notes, so it is on hold until it is checked.';
      end if;
      perform set_config('mutos.quiet', '', true);
    end if;
    perform public.card_note(k.id, public.person_name(m.to_person) || case when p_accept then ' accepted ' || k.code || ' from ' || public.person_name(m.from_person) || '.' || coalesce(why, '') else ' did not accept ' || k.code || ' (still with ' || public.person_name(m.from_person) || ')' end);
    n := n + 1;
  end loop;
  if n = 0 then return jsonb_build_object('error', 'These handovers are no longer waiting.'); end if;
  return jsonb_build_object('ok', true, 'count', n);
end $$;

create or replace function public.card_cancel(p_moves uuid[]) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare m public.card_moves; n int := 0;
begin
  for m in select * from public.card_moves where id = any(p_moves) and status = 'pending' loop
    if not (m.given_by = public.my_email() or public.is_staff()) then return jsonb_build_object('error', 'Only the giver can take it back.'); end if;
    update public.card_moves set status = 'cancelled', answered_by = public.my_email(), answered_at = now() where id = m.id;
    perform public.card_note(m.card, 'Handover to ' || public.person_name(m.to_person) || ' taken back');
    n := n + 1;
  end loop;
  if n = 0 then return jsonb_build_object('error', 'This handover is no longer waiting.'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ── the team leader's notes per card ────────────────────────────────────
create or replace function public.card_use(p_card uuid, p_used boolean, p_event text, p_shoot text, p_wedding text, p_media text, p_style text, p_camera text, p_note text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare k public.cards; me uuid := public.my_person(); uid uuid;
begin
  select * into k from public.cards where id = p_card;
  if not found then return jsonb_build_object('error', 'Unknown card.'); end if;
  if not ((k.holder is not null and k.holder = me) or public.is_card_desk()) then return jsonb_build_object('error', 'Only whoever has ' || k.code || ' can write its notes.'); end if;
  if p_used and coalesce(trim(p_shoot), '') = '' then return jsonb_build_object('error', 'Pick the shoot this card was used for.'); end if;
  if p_used and p_media is null then return jsonb_build_object('error', 'Photo or video?'); end if;
  perform set_config('mutos.quiet', '1', true);
  if p_used and k.data in ('single', 'copied') then   -- reused without being handed out: a new round
    update public.cards set data = 'empty', cycle = cycle + 1 where id = k.id; select * into k from public.cards where id = k.id;
  end if;
  insert into public.card_uses (card, cycle, used, event_id, shoot, wedding, media, style, camera, note, by_email, by_person)
    values (k.id, k.cycle, p_used, nullif(trim(p_event), ''), nullif(trim(p_shoot), ''), nullif(trim(p_wedding), ''), case when p_used then p_media end, case when p_used then p_style end, nullif(trim(p_camera), ''), nullif(trim(p_note), ''), public.my_email(), me)
    returning id into uid;
  if p_used and k.data = 'empty' then update public.cards set data = 'hold', data_since = now() where id = k.id; end if;
  perform set_config('mutos.quiet', '', true);
  perform public.card_note(k.id, case when p_used then 'Used: ' || concat_ws(' · ', p_shoot, p_media, p_style, nullif(trim(p_camera), ''), nullif(trim(p_note), '')) else 'Marked not used' || coalesce(' (' || nullif(trim(p_note), '') || ')', '') end);
  return jsonb_build_object('ok', true, 'id', uid);
end $$;

-- a note written by mistake: the writer (or the office) removes it before the card is copied
create or replace function public.card_use_remove(p_use uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare u public.card_uses; k public.cards;
begin
  select * into u from public.card_uses where id = p_use; if not found then return jsonb_build_object('error', 'Already removed.'); end if;
  select * into k from public.cards where id = u.card;
  if not (u.by_email = public.my_email() or public.is_staff()) then return jsonb_build_object('error', 'Only whoever wrote it can remove it.'); end if;
  if u.cycle <> k.cycle or exists (select 1 from public.card_copies where card = k.id and cycle = k.cycle) then return jsonb_build_object('error', 'This card is already copied; the note stays.'); end if;
  delete from public.card_uses where id = p_use;
  perform public.card_note(k.id, 'Note removed: ' || coalesce(u.shoot, 'not used'));
  return jsonb_build_object('ok', true);
end $$;

-- ── copying (owner and manager only) ────────────────────────────────────
-- p_items: [{ "title": "Sharma · Haldi", "wedding_key": "w:sharma" }] = the lines for the drive's contents (from the card's notes)
create or replace function public.card_copy(p_card uuid, p_drive uuid, p_folder text, p_files int, p_size text, p_items jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare k public.cards; d public.drives; first_drive uuid; is_bk boolean; it jsonb; ids uuid[] := '{}'; nid uuid; label text;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can mark a card copied.'); end if;
  select * into k from public.cards where id = p_card; if not found then return jsonb_build_object('error', 'Unknown card.'); end if;
  if k.data not in ('hold', 'single') then return jsonb_build_object('error', k.code || ' has nothing waiting to be copied.'); end if;
  select * into d from public.drives where id = p_drive;
  if d.id is null then return jsonb_build_object('error', 'Pick the drive it was copied to.'); end if;
  if d.status <> 'in_use' then return jsonb_build_object('error', d.name || ' is marked ' || replace(d.status, '_', ' ') || '.'); end if;
  if coalesce(p_files, 0) < 1 then return jsonb_build_object('error', 'Write how many files were copied (count them on the drive).'); end if;
  if coalesce(trim(p_folder), '') = '' then return jsonb_build_object('error', 'Write the folder on the drive.'); end if;
  is_bk := k.data = 'single';
  if is_bk then
    select drive into first_drive from public.card_copies where card = k.id and cycle = k.cycle and not card_copies.backup order by at desc limit 1;
    if first_drive = d.id then return jsonb_build_object('error', 'The backup must be on a different drive from the first copy.'); end if;
  end if;
  label := 'from card ' || k.code || ' · ' || trim(p_folder) || ' · ' || p_files || ' files';
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then p_items := jsonb_build_array(jsonb_build_object('title', 'Card ' || k.code)); end if;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.drive_items (drive, wedding_key, title, what, size_label, note)
      values (d.id, nullif(left(it ->> 'wedding_key', 200), ''), left(coalesce(nullif(trim(it ->> 'title'), ''), 'Card ' || k.code), 160), case when is_bk then 'backup' else 'raw' end, nullif(trim(p_size), ''), left(label, 300))
      returning id into nid;
    ids := ids || nid;
  end loop;
  insert into public.card_copies (card, cycle, backup, drive, drive_name, folder, files, size_label, items, by_email)
    values (k.id, k.cycle, is_bk, d.id, d.name, left(trim(p_folder), 200), p_files, nullif(trim(p_size), ''), ids, public.my_email());
  perform set_config('mutos.quiet', '1', true);
  update public.cards set data = case when is_bk then 'copied' else 'single' end, data_since = null where id = k.id;
  perform set_config('mutos.quiet', '', true);
  perform public.card_note(k.id, case when is_bk then 'Backup copied to ' else 'Copied to ' end || d.name || ' / ' || trim(p_folder) || ' (' || p_files || ' files' || coalesce(', ' || nullif(trim(p_size), ''), '') || ')' || case when is_bk then '. Safe: two copies.' else '. Single copy: safe to format, backup pending.' end);
  perform public.drive_note(d.id, (case when is_bk then 'Backup from card ' else 'Copied from card ' end) || k.code || ' into ' || trim(p_folder));
  return jsonb_build_object('ok', true, 'backup', is_bk);
end $$;

-- nothing was really on it (e.g. it came back without notes and is empty): owner or manager clears the hold
create or replace function public.card_mark_empty(p_card uuid, p_why text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare k public.cards;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can clear a hold.'); end if;
  select * into k from public.cards where id = p_card; if not found or k.data <> 'hold' then return jsonb_build_object('error', 'This card is not on hold.'); end if;
  if coalesce(trim(p_why), '') = '' then return jsonb_build_object('error', 'Write why (e.g. "checked: card is empty").'); end if;
  perform set_config('mutos.quiet', '1', true);
  update public.cards set data = 'empty', data_since = null where id = k.id;
  perform set_config('mutos.quiet', '', true);
  perform public.card_note(k.id, 'Hold cleared: ' || left(trim(p_why), 200));
  return jsonb_build_object('ok', true);
end $$;

-- ── problems: errors, damaged, lost ─────────────────────────────────────
create or replace function public.card_problem(p_card uuid, p_kind text, p_note text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare k public.cards; me uuid := public.my_person(); txt text;
begin
  select * into k from public.cards where id = p_card; if not found then return jsonb_build_object('error', 'Unknown card.'); end if;
  if p_kind in ('error', 'damaged', 'lost') then
    if not ((k.holder is not null and k.holder = me) or public.is_card_desk()) then return jsonb_build_object('error', 'Only whoever has ' || k.code || ' can report it.'); end if;
  elsif p_kind in ('found', 'ok', 'retired') then
    if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can change this.'); end if;
  else return jsonb_build_object('error', 'Unknown problem.'); end if;
  perform set_config('mutos.quiet', '1', true);
  if p_kind = 'error' then
    update public.cards set errors = errors + 1, condition = case when errors + 1 >= 2 then 'retired' else condition end where id = k.id returning * into k;
    txt := 'Error reported (' || k.errors || ')' || case when k.condition = 'retired' then ': retired after two errors, do not use it again' else '' end;
  elsif p_kind in ('damaged', 'lost', 'retired') then
    update public.cards set condition = p_kind where id = k.id; txt := 'Marked ' || p_kind;
  else
    update public.cards set condition = 'ok', errors = case when p_kind = 'ok' then 0 else errors end where id = k.id; txt := case when p_kind = 'found' then 'Found' else 'Back in use (errors reset)' end;
  end if;
  perform set_config('mutos.quiet', '', true);
  perform public.card_note(k.id, txt || coalesce(': ' || nullif(trim(p_note), ''), ''));
  return jsonb_build_object('ok', true);
end $$;

-- the owner corrects where a card is (e.g. after the first import), with a line in the history
create or replace function public.card_set_holder(p_card uuid, p_person uuid, p_why text) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then return jsonb_build_object('error', 'Only the admin can correct this.'); end if;
  if not exists (select 1 from public.cards where id = p_card) then return jsonb_build_object('error', 'Unknown card.'); end if;
  update public.card_moves set status = 'cancelled', answered_by = public.my_email(), answered_at = now() where card = p_card and status = 'pending';
  perform set_config('mutos.quiet', '1', true);
  update public.cards set holder = p_person where id = p_card;
  perform set_config('mutos.quiet', '', true);
  perform public.card_note(p_card, 'Corrected by the admin: now with ' || public.person_name(p_person) || coalesce(' (' || nullif(trim(p_why), '') || ')', ''));
  return jsonb_build_object('ok', true);
end $$;

-- ── access rules ────────────────────────────────────────────────────────
alter table public.cards enable row level security;
alter table public.card_moves enable row level security;
alter table public.card_uses enable row level security;
alter table public.card_copies enable row level security;
alter table public.card_log enable row level security;

-- everyone at Muto's sees the cards, their notes and where they were copied (so the team can check)
drop policy if exists cards_select on public.cards;
create policy cards_select on public.cards for select to authenticated using (public.is_card_desk() or public.my_person() is not null);
drop policy if exists cards_insert on public.cards;
create policy cards_insert on public.cards for insert to authenticated with check (public.is_staff());
drop policy if exists cards_update on public.cards;
create policy cards_update on public.cards for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists cards_delete on public.cards;
create policy cards_delete on public.cards for delete to authenticated using (public.is_owner());
drop policy if exists cmoves_select on public.card_moves;
create policy cmoves_select on public.card_moves for select to authenticated using (public.is_card_desk() or public.my_person() is not null);
drop policy if exists cuses_select on public.card_uses;
create policy cuses_select on public.card_uses for select to authenticated using (public.is_card_desk() or public.my_person() is not null);
drop policy if exists ccopies_select on public.card_copies;
create policy ccopies_select on public.card_copies for select to authenticated using (public.is_card_desk() or public.my_person() is not null);
drop policy if exists clog_select on public.card_log;
create policy clog_select on public.card_log for select to authenticated using (public.is_card_desk() or public.my_person() is not null);

revoke all on public.cards, public.card_moves, public.card_uses, public.card_copies, public.card_log from anon, authenticated;
grant select, insert, delete on public.cards to authenticated;
grant update (code, kind, size_label, brand, serial, notes) on public.cards to authenticated;   -- holder, data, condition: only through the functions
grant select on public.card_moves, public.card_uses, public.card_copies, public.card_log to authenticated;
revoke all on function public.card_give(uuid[], uuid, text), public.card_answer(uuid[], boolean), public.card_cancel(uuid[]),
  public.card_use(uuid, boolean, text, text, text, text, text, text, text), public.card_use_remove(uuid), public.card_copy(uuid, uuid, text, int, text, jsonb),
  public.card_mark_empty(uuid, text), public.card_problem(uuid, text, text), public.card_set_holder(uuid, uuid, text), public.card_note(uuid, text), public.person_is_desk(uuid) from public, anon;
grant execute on function public.card_give(uuid[], uuid, text), public.card_answer(uuid[], boolean), public.card_cancel(uuid[]),
  public.card_use(uuid, boolean, text, text, text, text, text, text, text), public.card_use_remove(uuid), public.card_copy(uuid, uuid, text, int, text, jsonb),
  public.card_mark_empty(uuid, text), public.card_problem(uuid, text, text), public.card_set_holder(uuid, uuid, text) to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.card_moves; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.cards; exception when duplicate_object then null; end;
end $$;

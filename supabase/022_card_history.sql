-- 022: cards ↔ client history (12 Nov 2026, Ravi). Run after 021.
-- "While assigning a card to an event the shooters must see all the shoots with clients name, whether past, present or future.
--  Owner and manager can also adjust the cards entries to assign it to some other client or shoot. These all logs must be attached
--  with client's history, which can only be seen by manager and owner. Also, owner and manager can see who received cards."
--
-- card_shoots()     every shoot on the board (past, today, future; not cancelled) with its wedding / client name, for anyone who
--                   can hold cards (the board itself stays closed to the team). No phone numbers.
-- card_use_edit()   admin (owner) or manager moves a card's note to another shoot / client, with a reason; the drive lines made
--                   from that card's copies follow; logged on the card and on BOTH shoots' client history.
-- client_log        the client's history (per shoot = board event id): every line of a card's log while the card holds footage of
--                   that shoot (used, given, received by whom, copied, backup, moved). Only admin and manager can read it.
-- card_answer       the log now says who really received a card for the office (e.g. "Ravi (admin) received C01 for the office").
-- Wording           the owner is called "admin" on screen (Ravi, 12 Nov): the messages of the functions already in the database are
--                   rewritten below (the role itself stays 'owner', so nothing changes in who may do what).

create or replace function public.role_word(e text) returns text language sql stable security definer set search_path = public as $$
  select case (select role from public.members where email = e) when 'owner' then 'admin' when 'manager' then 'manager' when 'supervisor' then 'supervisor' else null end $$;
-- "Ravi (admin)" for the signed-in person
create or replace function public.me_label() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select name from public.people where id = public.my_person()), (select display_name from public.members where email = public.my_email()), public.my_email())
    || coalesce(' (' || public.role_word(public.my_email()) || ')', '') $$;

-- ── the client's history ────────────────────────────────────────────────
create table if not exists public.client_log (
  id       bigserial primary key,
  event_id text not null check (length(event_id) <= 100),
  wedding  text,
  shoot    text,
  card     uuid references public.cards(id) on delete set null,
  kind     text not null default 'card',
  at       timestamptz not null default now(),
  by_email text not null default public.my_email(),
  what     text not null check (length(what) <= 600)
);
create index if not exists client_log_event on public.client_log (event_id, at desc);
alter table public.client_log enable row level security;
drop policy if exists client_log_select on public.client_log;
create policy client_log_select on public.client_log for select to authenticated using (public.is_staff());
revoke all on public.client_log from anon, authenticated;
grant select on public.client_log to authenticated;

-- every card log line goes to the history of each shoot whose footage is on the card in this round
create or replace function public.card_log_to_client() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.card is null then return null; end if;
  insert into public.client_log (event_id, wedding, shoot, card, kind, at, by_email, what)
    select distinct on (u.event_id) u.event_id, u.wedding, u.shoot, new.card, 'card', new.at, new.by_email, left(k.code || ': ' || new.what, 600)
    from public.card_uses u join public.cards k on k.id = u.card
    where u.card = new.card and u.cycle = k.cycle and u.used and u.event_id is not null
    order by u.event_id, u.at;
  return null;
end $$;
drop trigger if exists card_log_to_client on public.card_log;
create trigger card_log_to_client after insert on public.card_log for each row execute function public.card_log_to_client();

-- ── all shoots for the notes picker ─────────────────────────────────────
create or replace function public.card_shoots() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_card_desk() or public.my_person() is not null) then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.data ->> 'name', 'wedding', d.data ->> 'wedding', 'date', d.data ->> 'date',
      'slot', d.data ->> 'slot', 'contactName', d.data ->> 'contactName', 'location', left(d.data ->> 'location', 120)) order by d.data ->> 'date' desc)
    from public.docs d
    where d.collection = 'events' and coalesce(d.data ->> 'status', '') <> 'cancelled' and coalesce(d.data ->> 'date', '') <> ''), '[]'::jsonb);
end $$;

-- ── who received it ─────────────────────────────────────────────────────
create or replace function public.card_answer(p_moves uuid[], p_accept boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare m public.card_moves; k public.cards; n int := 0; why text; who text;
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
    -- for the office: name the person who really took it (admin or manager)
    who := case when m.to_person is null then public.me_label() else public.person_name(m.to_person) end;
    -- the history line is written before the card changes round, so the shoots on it get "received by …"
    perform public.card_note(k.id, case when p_accept then who || ' received ' || k.code || case when m.to_person is null then ' for the office' else '' end || ' from ' || public.person_name(m.from_person) || '.'
      else who || ' did not accept ' || k.code || case when m.to_person is null then ' for the office' else '' end || ' (still with ' || public.person_name(m.from_person) || ')' end);
    update public.card_moves set status = case when p_accept then 'accepted' else 'declined' end, answered_by = public.my_email(), answered_at = now() where id = m.id;
    if p_accept then
      why := null;
      perform set_config('mutos.quiet', '1', true);
      if m.from_person is null and k.data in ('single', 'copied') then
        update public.cards set data = 'empty', data_since = null, cycle = cycle + 1, with_team = false where id = k.id;
        why := 'Old footage was already copied (' || case when k.data = 'single' then 'single copy' else 'with backup' end || '), so it can be formatted.';
        select * into k from public.cards where id = k.id;
      end if;
      update public.cards set holder = m.to_person, with_team = with_team or (m.to_person is not null and not public.person_is_desk(m.to_person)) where id = k.id;
      select * into k from public.cards where id = k.id;
      if m.to_person is null and k.data = 'empty' and k.with_team and not exists (select 1 from public.card_uses where card = k.id and cycle = k.cycle) then
        update public.cards set data = 'hold', data_since = now() where id = k.id;
        why := concat_ws(' ', why, 'Came back without notes, so it is on hold until it is checked.');
      end if;
      perform set_config('mutos.quiet', '', true);
      if why is not null then perform public.card_note(k.id, why); end if;
    end if;
    n := n + 1;
  end loop;
  if n = 0 then return jsonb_build_object('error', 'These handovers are no longer waiting.'); end if;
  return jsonb_build_object('ok', true, 'count', n);
end $$;

-- ── admin / manager moves a card's note to another shoot or client ──────
-- p_new_title / p_old_title: the drive-line titles the Cards page builds for the new and the old shoot (as when copying)
create or replace function public.card_use_edit(p_use uuid, p_event text, p_shoot text, p_wedding text, p_new_title text, p_old_title text, p_wedding_key text, p_why text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare u public.card_uses; k public.cards; n_used int; ids uuid[]; moved int := 0; txt text;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can move a card''s note to another shoot.'); end if;
  select * into u from public.card_uses where id = p_use; if not found then return jsonb_build_object('error', 'This note is gone.'); end if;
  if not u.used then return jsonb_build_object('error', 'This note says the card was not used.'); end if;
  if coalesce(trim(p_shoot), '') = '' then return jsonb_build_object('error', 'Pick the shoot.'); end if;
  if coalesce(trim(p_why), '') = '' then return jsonb_build_object('error', 'Write why (e.g. "team wrote the wrong function").'); end if;
  if nullif(trim(p_event), '') is not distinct from u.event_id and trim(p_shoot) = coalesce(u.shoot, '') then return jsonb_build_object('error', 'That is already the shoot on this note.'); end if;
  select * into k from public.cards where id = u.card;
  txt := k.code || ': moved from ' || coalesce(u.shoot, '?') || ' to ' || trim(p_shoot) || ' by ' || public.me_label() || ' (' || left(trim(p_why), 200) || ')';
  -- the old shoot's history keeps a line saying where the footage went
  if u.event_id is not null then
    insert into public.client_log (event_id, wedding, shoot, card, kind, what) values (u.event_id, u.wedding, u.shoot, k.id, 'card', left(txt, 600));
  end if;
  update public.card_uses set event_id = nullif(left(trim(p_event), 100), ''), shoot = left(trim(p_shoot), 160), wedding = nullif(left(trim(p_wedding), 160), '') where id = p_use;
  -- the drive lines made from this card's copies in that round follow the note
  select count(*) into n_used from public.card_uses where card = k.id and cycle = u.cycle and used;
  select coalesce(array_agg(x), '{}') into ids from public.card_copies cc, unnest(cc.items) x where cc.card = k.id and cc.cycle = u.cycle;
  if coalesce(array_length(ids, 1), 0) > 0 and coalesce(trim(p_new_title), '') <> '' then
    update public.drive_items set title = left(trim(p_new_title), 160), wedding_key = nullif(left(trim(coalesce(p_wedding_key, '')), 200), '')
      where id = any(ids) and removed_at is null and (n_used = 1 or title = trim(p_old_title));
    get diagnostics moved = row_count;
  end if;
  -- a note from an earlier round is not "on the card" any more, so the trigger below would not reach the new shoot: write it here
  if u.cycle <> k.cycle and nullif(trim(p_event), '') is not null then
    insert into public.client_log (event_id, wedding, shoot, card, kind, what) values (left(trim(p_event), 100), nullif(trim(p_wedding), ''), trim(p_shoot), k.id, 'card',
      left(k.code || ': footage of round ' || u.cycle || ' moved here from ' || coalesce(u.shoot, '?') || ' by ' || public.me_label() || ' (' || left(trim(p_why), 200) || ')', 600));
  end if;
  -- the card's own log (and, through the trigger, the new shoot's history)
  perform public.card_note(k.id, 'Note moved from ' || coalesce(u.shoot, '?') || ' to ' || trim(p_shoot) || ' by ' || public.me_label() || ' (' || left(trim(p_why), 200) || ')'
    || case when moved > 0 then '. ' || moved || ' drive line' || case when moved > 1 then 's' else '' end || ' renamed.' else '' end);
  return jsonb_build_object('ok', true, 'drive_lines', moved);
end $$;

revoke all on function public.card_shoots(), public.card_use_edit(uuid, text, text, text, text, text, text, text), public.role_word(text), public.me_label() from public, anon;
grant execute on function public.card_shoots(), public.card_use_edit(uuid, text, text, text, text, text, text, text) to authenticated;

-- ── once: the history so far (notes written and copies made before this file) ──
do $$ begin
  if not exists (select 1 from public.client_log) then
    insert into public.client_log (event_id, wedding, shoot, card, kind, at, by_email, what)
      select distinct on (u.event_id, l.id) u.event_id, u.wedding, u.shoot, l.card, 'card', l.at, l.by_email, left(k.code || ': ' || l.what, 600)
      from public.card_log l
      join public.card_uses u on u.card = l.card and u.used and u.event_id is not null and l.at >= u.at - interval '2 seconds'
        and l.at < coalesce((select min(u2.at) from public.card_uses u2 where u2.card = u.card and u2.cycle > u.cycle), 'infinity'::timestamptz)
      join public.cards k on k.id = l.card
      order by u.event_id, l.id;
  end if;
end $$;

-- ── "admin", not "owner", in the messages people see ─────────────────────
do $$
declare f record; def text; nd text;
begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ '(Only the owner|Corrected by the owner|the owner or manager assigns)' loop
    def := pg_get_functiondef(f.oid);
    nd := replace(replace(replace(replace(def, 'Only the owner or the manager', 'Only the admin or the manager'), 'Only the owner can', 'Only the admin can'), 'Corrected by the owner', 'Corrected by the admin'), 'the owner or manager assigns', 'the admin or manager assigns');
    if nd <> def then execute nd; end if;
  end loop;
end $$;

-- 026: photos on Google Drive (14 Nov 2026, Ravi: "my team can also upload photos of cards after shoot with details. Also the
-- clients can also upload high quality photos of reference and important people. It should not use storage at cloudflare and
-- supabase."). Run after 025.
-- The photo files live in the studio's Google Drive (the Worker uploads them with the studio Gmail, /api/photos/*). This table
-- only remembers which Drive file is which (a few hundred bytes per photo). Nobody writes it directly: upload_begin() checks who
-- may add a photo and makes the row, the Worker fills in the Drive file ids with the server key once Google has the file.
--   card   : photos of memory cards after a shoot (any card desk login or anyone on People), several cards per photo
--   client : the family's photos: 'vip' (an important person) or 'ref' (reference / inspiration), shrunk to ~3000px on the phone
-- Who sees them: card photos = the card desk + everyone on People (same as the cards); family photos = the studio desk, the
-- family's own Gmails, and the crew on a shoot of that wedding (same check as crew_vip).

create table if not exists public.uploads (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('card', 'client')),
  purpose     text not null check (purpose in ('card', 'vip', 'ref')),
  wedding_key text check (length(wedding_key) <= 200),
  cards       uuid[] not null default '{}',
  cycles      int[] not null default '{}',          -- each card's round when the photo was added (same order as cards)
  event_id    text check (length(event_id) <= 100),
  name        text not null check (length(name) <= 200),
  mime        text not null check (mime like 'image/%'),
  size        bigint,
  width       int, height int,
  note        text check (length(note) <= 300),
  drive_id    text,                                 -- the photo on Google Drive
  thumb_id    text,                                 -- a small copy (~480px) for lists
  status      text not null default 'pending' check (status in ('pending', 'ok')),
  by_email    text not null,
  by_person   uuid,
  at          timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  text
);
create index if not exists uploads_wedding on public.uploads (wedding_key) where kind = 'client';
create index if not exists uploads_cards on public.uploads using gin (cards);
alter table public.uploads enable row level security;

-- may the signed-in person see a family's photos?
create or replace function public.upload_sees_wedding(p_key text) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_desk()
    or exists (select 1 from public.client_links l where l.wedding_key = p_key and l.active and public.my_email() <> '' and public.my_email() = any(l.emails))
    or exists (select 1 from public.crew_feed f, jsonb_array_elements(coalesce(f.data -> 'shoots', '[]'::jsonb)) s,
                             public.client_feed cf, jsonb_array_elements(coalesce(cf.data -> 'functions', '[]'::jsonb)) fn
               where f.person_key = public.my_person_key() and cf.wedding_key = p_key and fn ->> 'id' = s ->> 'id') $$;

create or replace function public.upload_sees(u public.uploads) returns boolean
  language sql stable security definer set search_path = public as $$
  select case u.kind when 'card' then public.is_card_desk() or public.my_person() is not null
                     else public.upload_sees_wedding(u.wedding_key) end $$;

drop policy if exists uploads_select on public.uploads;
create policy uploads_select on public.uploads for select to authenticated
  using (status = 'ok' and removed_at is null and public.upload_sees(uploads));
revoke all on public.uploads from anon, authenticated;
grant select on public.uploads to authenticated;

-- start a photo: checks, then a 'pending' row. Returns the row id and the Drive folder it goes into.
create or replace function public.upload_begin(p_kind text, p_ref text, p_cards uuid[], p_purpose text, p_event text,
                                               p_name text, p_mime text, p_size bigint, p_note text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare l public.client_links; fam boolean; n int; cyc int[]; codes text; id uuid; folder text[]; fname text;
  stamp text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24.MI.SS');
begin
  if public.my_email() = '' then return jsonb_build_object('error', 'Sign in first.'); end if;
  if coalesce(p_mime, '') !~ '^image/[a-z0-9.+-]+$' then return jsonb_build_object('error', 'Only photos can be added.'); end if;
  if coalesce(p_size, 0) <= 0 or p_size > 25 * 1024 * 1024 then return jsonb_build_object('error', 'This photo is too big (25 MB at most).'); end if;
  select count(*) into n from public.uploads where by_email = public.my_email() and at > now() - interval '1 hour';
  if n >= 120 then return jsonb_build_object('error', 'Too many photos in one hour. Try again a little later.'); end if;
  if p_kind = 'card' then
    if not (public.is_card_desk() or public.my_person() is not null) then return jsonb_build_object('error', 'Only the team on Muto''s People list can add card photos.'); end if;
    if coalesce(array_length(p_cards, 1), 0) = 0 or array_length(p_cards, 1) > 20 then return jsonb_build_object('error', 'Pick the cards in the photo.'); end if;
    select array_agg(k.cycle order by x.o), string_agg(k.code, ' ' order by x.o) into cyc, codes
      from unnest(p_cards) with ordinality x(cid, o) join public.cards k on k.id = x.cid;
    if coalesce(array_length(cyc, 1), 0) <> array_length(p_cards, 1) then return jsonb_build_object('error', 'Unknown card.'); end if;
    folder := array['Cards', to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM')];
    fname := left(codes, 120) || ' · ' || stamp;
    insert into public.uploads (kind, purpose, cards, cycles, event_id, name, mime, size, note, by_email, by_person)
    values ('card', 'card', p_cards, cyc, nullif(left(coalesce(p_event, ''), 100), ''), fname, p_mime, p_size, nullif(left(trim(coalesce(p_note, '')), 300), ''), public.my_email(), public.my_person())
    returning uploads.id into id;
  elsif p_kind = 'client' then
    if p_purpose not in ('vip', 'ref') then return jsonb_build_object('error', 'Unknown photo type.'); end if;
    begin select * into l from public.client_links where token = p_ref::uuid and active; exception when others then l := null; end;
    if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
    fam := public.my_email() = any(l.emails);
    if not (fam or public.is_desk()) then return jsonb_build_object('error', 'Only the family''s registered Gmail can add photos.'); end if;
    select count(*) into n from public.uploads where kind = 'client' and wedding_key = l.wedding_key and removed_at is null;
    if n >= 300 then return jsonb_build_object('error', 'This wedding already has 300 photos. Remove a few first.'); end if;
    folder := array['Families', left(regexp_replace(l.title, '[/\\]', '-', 'g'), 100)];
    fname := case p_purpose when 'vip' then 'Important person' else 'Reference' end || coalesce(' · ' || nullif(left(trim(coalesce(p_note, '')), 60), ''), '') || ' · ' || stamp;
    insert into public.uploads (kind, purpose, wedding_key, event_id, name, mime, size, note, by_email, by_person)
    values ('client', p_purpose, l.wedding_key, nullif(left(coalesce(p_event, ''), 100), ''), fname, p_mime, p_size, nullif(left(trim(coalesce(p_note, '')), 300), ''), public.my_email(), public.my_person())
    returning uploads.id into id;
  else
    return jsonb_build_object('error', 'Unknown photo type.');
  end if;
  return jsonb_build_object('id', id, 'folder', to_jsonb(folder), 'name', fname);
end $$;

-- may I open this photo? (the Worker asks with the viewer's own sign-in before it fetches the file from Drive)
create or replace function public.upload_check(p_id uuid, p_thumb boolean) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare u public.uploads;
begin
  select * into u from public.uploads where id = p_id and status = 'ok' and removed_at is null;
  if not found or not public.upload_sees(u) then return jsonb_build_object('error', 'Not found.'); end if;
  return jsonb_build_object('drive_id', case when p_thumb then coalesce(u.thumb_id, u.drive_id) else u.drive_id end,
    'mime', case when p_thumb and u.thumb_id is not null then 'image/jpeg' else u.mime end, 'name', u.name);
end $$;

-- take a photo off the list (the file stays in the studio's Drive): whoever added it, or the admin / manager
create or replace function public.upload_remove(p_id uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare u public.uploads;
begin
  select * into u from public.uploads where id = p_id and removed_at is null;
  if not found then return jsonb_build_object('error', 'Already removed.'); end if;
  if not (u.by_email = public.my_email() or public.is_staff()) then return jsonb_build_object('error', 'Only the person who added it, or the admin or manager, can remove it.'); end if;
  update public.uploads set removed_at = now(), removed_by = public.my_email() where id = p_id;
  if u.kind = 'card' then perform public.card_note(c, 'Photo removed by ' || public.me_label()) from unnest(u.cards) c; end if;
  return jsonb_build_object('ok', true);
end $$;

-- a card photo that reached Drive goes in the card's history (the Worker calls this with the server key)
create or replace function public.uploads_card_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'card' and new.status = 'ok' and old.status = 'pending' then
    perform public.card_note(c, 'Photo added by ' || coalesce((select name from public.people where id = new.by_person), new.by_email) || coalesce(': ' || new.note, '')) from unnest(new.cards) c;
  end if;
  return null;
end $$;
drop trigger if exists uploads_card_trg on public.uploads;
create trigger uploads_card_trg after update of status on public.uploads for each row execute function public.uploads_card_trg();

revoke all on function public.upload_sees_wedding(text), public.upload_sees(public.uploads), public.upload_begin(text, text, uuid[], text, text, text, text, bigint, text),
  public.upload_check(uuid, boolean), public.upload_remove(uuid) from public, anon;
grant execute on function public.upload_sees_wedding(text), public.upload_sees(public.uploads), public.upload_begin(text, text, uuid[], text, text, text, text, bigint, text),
  public.upload_check(uuid, boolean), public.upload_remove(uuid) to authenticated;

-- the crew also get the family's reference photos for their function (and the ones meant for all functions)
create or replace function public.crew_vip(p_event text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare k text; d jsonb;
begin
  if not (public.is_staff() or exists (select 1 from public.crew_feed f, jsonb_array_elements(coalesce(f.data -> 'shoots', '[]'::jsonb)) s
                                       where f.person_key = public.my_person_key() and s ->> 'id' = p_event)) then
    return jsonb_build_object('error', 'Only the crew on this shoot can see the family''s details.');
  end if;
  select cf.wedding_key into k from public.client_feed cf, jsonb_array_elements(coalesce(cf.data -> 'functions', '[]'::jsonb)) fn where fn ->> 'id' = p_event limit 1;
  if k is null then return jsonb_build_object('vip', '[]'::jsonb, 'contacts', '[]'::jsonb, 'couple', '{}'::jsonb, 'refs', '[]'::jsonb); end if;
  select data into d from public.client_itinerary where wedding_key = k;
  return jsonb_build_object('vip', coalesce(d -> 'vip', '[]'::jsonb),
    'contacts', coalesce((select jsonb_agg(c) from jsonb_array_elements(coalesce(d -> 'contacts', '[]'::jsonb)) c where coalesce(c ->> 'fn', '') in ('', p_event)), '[]'::jsonb),
    'couple', jsonb_build_object('bride', left(coalesce(d #>> '{couple,bride}', ''), 80), 'groom', left(coalesce(d #>> '{couple,groom}', ''), 80)),
    'refs', coalesce((select jsonb_agg(r) from jsonb_array_elements(coalesce(d -> 'refs', '[]'::jsonb)) r where coalesce(r ->> 'fn', '') in ('', p_event)), '[]'::jsonb));
end $$;
revoke all on function public.crew_vip(text) from public, anon;
grant execute on function public.crew_vip(text) to authenticated;

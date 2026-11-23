-- 040 (23 Nov 2026, Ravi: "Profile photo?" → shown on families' "Your team" card, crew "Team with you", People and the board's
-- crew list; kept on the studio's Google Drive like the other photos; families see it only after the admin / manager approve it).
-- Run after 039. Needs 026_photos.sql (photos on Google Drive) and Drive connected (Home → Settings → Photos on Google Drive).
--   · a team member adds / changes their photo from My Profile → uploads (kind 'person', purpose 'avatar') + team_photos 'pending'
--   · the admin / manager approve or reject it (Home → Needs you); approving replaces the person's earlier photo
--   · approved photos: the studio and the team see them; a family sees a team member's photo only on its "Your team" card
--     (the same day-before window as 038); a pending photo is seen only by its owner and the studio
do $$ begin if to_regclass('public.uploads') is null then raise exception 'Run 026_photos.sql first (photos on Google Drive).'; end if; end $$;

alter table public.uploads drop constraint if exists uploads_kind_check;
alter table public.uploads add constraint uploads_kind_check check (kind in ('card', 'client', 'person'));
alter table public.uploads drop constraint if exists uploads_purpose_check;
alter table public.uploads add constraint uploads_purpose_check check (purpose in ('card', 'vip', 'ref', 'pay', 'avatar'));

create table if not exists public.team_photos (
  id          bigserial primary key,
  upload      uuid not null unique references public.uploads(id) on delete cascade,
  person      uuid,
  names       text[] not null default '{}',     -- the person's names in lower case (board records + People), to find them on teams
  name        text not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'replaced')),
  by_email    text not null,
  at          timestamptz not null default now(),
  decided_by  text,
  decided_at  timestamptz,
  why         text check (length(why) <= 200)
);
create index if not exists team_photos_status on public.team_photos (status);
alter table public.team_photos enable row level security;
drop policy if exists team_photos_read on public.team_photos;
create policy team_photos_read on public.team_photos for select to authenticated
  using (public.is_desk() or by_email = public.my_email()
         or (status = 'approved' and (public.my_person() is not null or exists (select 1 from public.members m where m.email = public.my_email()))));
revoke all on public.team_photos from anon, authenticated;
grant select on public.team_photos to authenticated;

-- the signed-in person's names in lower case (their board records, their People name)
create or replace function public.my_names() returns text[]
  language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct n) filter (where n is not null and n <> ''), '{}') from (
    select lower(trim(d.data ->> 'name')) n from public.my_board_records() d
    union select lower(trim(name)) from public.people where email = public.my_email() and public.my_email() <> '' and active) x $$;
revoke all on function public.my_names() from public, anon, authenticated;

-- may I see this photo? (person photos: see the header)
create or replace function public.upload_sees(u public.uploads) returns boolean
  language sql stable security definer set search_path = public as $s$
  select case
    when u.kind = 'card' then public.is_card_desk() or public.my_person() is not null
    when u.kind = 'person' then public.is_desk() or u.by_email = public.my_email()
      or exists (select 1 from public.team_photos tp where tp.upload = u.id and tp.status = 'approved' and (
           public.my_person() is not null or exists (select 1 from public.members m where m.email = public.my_email())
           or exists (select 1 from public.client_links l join public.client_feed cf on cf.wedding_key = l.wedding_key
                        cross join lateral jsonb_array_elements(coalesce(cf.data -> 'functions', '[]'::jsonb)) fn
                        cross join lateral jsonb_array_elements(coalesce(cf.data -> 'team' -> (fn ->> 'id'), '[]'::jsonb)) t
                       where l.active and public.my_email() <> '' and public.my_email() = any(l.emails)
                         and (fn ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
                         and (fn ->> 'date')::date between (now() at time zone 'Asia/Kolkata')::date and (now() at time zone 'Asia/Kolkata')::date + 1
                         and lower(trim(t ->> 'name')) = any(tp.names))))
    when u.purpose = 'pay' then public.is_staff() or public.is_payroll()
      or exists (select 1 from public.client_links l where l.wedding_key = u.wedding_key and l.active and public.my_email() <> '' and public.my_email() = any(l.emails))
    else public.upload_sees_wedding(u.wedding_key) end $s$;

do $do$
begin
  execute $f$
  create or replace function public.upload_begin(p_kind text, p_ref text, p_cards uuid[], p_purpose text, p_event text,
                                                 p_name text, p_mime text, p_size bigint, p_note text) returns jsonb
    language plpgsql security definer set search_path = public as $b$
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
      if p_purpose not in ('vip', 'ref', 'pay') then return jsonb_build_object('error', 'Unknown photo type.'); end if;
      begin select * into l from public.client_links where token = p_ref::uuid and active; exception when others then l := null; end;
      if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
      fam := public.my_email() = any(l.emails);
      if p_purpose = 'pay' and not fam then return jsonb_build_object('error', 'Only the family''s registered Gmail can add a payment screenshot.'); end if;
      if not (fam or public.is_desk()) then return jsonb_build_object('error', 'Only the family''s registered Gmail can add photos.'); end if;
      select count(*) into n from public.uploads where kind = 'client' and wedding_key = l.wedding_key and removed_at is null;
      if n >= 300 then return jsonb_build_object('error', 'This wedding already has 300 photos. Remove a few first.'); end if;
      folder := array['Families', left(regexp_replace(l.title, '[/\\]', '-', 'g'), 100)] || case when p_purpose = 'pay' then array['Payments'] else '{}'::text[] end;
      fname := case p_purpose when 'vip' then 'Important person' when 'pay' then 'Payment' else 'Reference' end || coalesce(' · ' || nullif(left(trim(coalesce(p_note, '')), 60), ''), '') || ' · ' || stamp;
      insert into public.uploads (kind, purpose, wedding_key, event_id, name, mime, size, note, by_email, by_person)
      values ('client', p_purpose, l.wedding_key, nullif(left(coalesce(p_event, ''), 100), ''), fname, p_mime, p_size, nullif(left(trim(coalesce(p_note, '')), 300), ''), public.my_email(), public.my_person())
      returning uploads.id into id;
    elsif p_kind = 'person' then
      -- a team member's own profile photo (040): waits for the admin / manager before anyone else sees it
      if not (public.my_person() is not null or exists (select 1 from public.my_board_records())) then
        return jsonb_build_object('error', 'You are not on the studio''s team list yet. Please ask Muto''s.'); end if;
      select count(*) into n from public.team_photos where by_email = public.my_email() and at > now() - interval '1 day';
      if n >= 5 then return jsonb_build_object('error', 'Too many photos today. Please try tomorrow.'); end if;
      folder := array['Team photos'];
      fname := left(coalesce((select pp.name from public.people pp where pp.id = public.my_person()), (select d.data ->> 'name' from public.my_board_records() d limit 1), public.my_email()), 80) || ' · ' || stamp;
      insert into public.uploads (kind, purpose, name, mime, size, note, by_email, by_person)
      values ('person', 'avatar', fname, p_mime, p_size, null, public.my_email(), public.my_person())
      returning uploads.id into id;
      insert into public.team_photos (upload, person, names, name, by_email) values (id, public.my_person(), public.my_names(), split_part(fname, ' · ', 1), public.my_email());
    else
      return jsonb_build_object('error', 'Unknown photo type.');
    end if;
    return jsonb_build_object('id', id, 'folder', to_jsonb(folder), 'name', fname);
  end $b$ $f$;
end $do$;

-- approved photos by name, for the crew pages, People and the board (not for families: they get theirs through client_team)
create or replace function public.team_photo_map() returns jsonb
  language sql stable security definer set search_path = public as $$
  select case when public.is_desk() or public.my_person() is not null or exists (select 1 from public.members m where m.email = public.my_email()) then
    coalesce((select jsonb_agg(jsonb_build_object('upload', tp.upload, 'person', tp.person, 'names', to_jsonb(tp.names), 'name', tp.name) order by tp.decided_at)
                from public.team_photos tp join public.uploads u on u.id = tp.upload
               where tp.status = 'approved' and u.status = 'ok' and u.removed_at is null), '[]'::jsonb)
  else '[]'::jsonb end $$;
revoke all on function public.team_photo_map() from public, anon;
grant execute on function public.team_photo_map() to authenticated;

-- my own latest photo and where it stands
create or replace function public.my_team_photo() returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('upload', tp.upload, 'status', tp.status, 'why', tp.why, 'at', tp.at)
                     from public.team_photos tp join public.uploads u on u.id = tp.upload
                    where tp.by_email = public.my_email() and u.status = 'ok' and tp.status <> 'replaced' order by tp.at desc limit 1), '{}'::jsonb) $$;
revoke all on function public.my_team_photo() from public, anon;
grant execute on function public.my_team_photo() to authenticated;

-- the admin / manager approve (the person's earlier photo is replaced) or reject (with a reason the person sees)
create or replace function public.team_photo_decide(p_id bigint, p_approve boolean, p_why text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare tp public.team_photos;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can approve photos.'); end if;
  select * into tp from public.team_photos where id = p_id for update;
  if tp.id is null then return jsonb_build_object('error', 'Unknown photo.'); end if;
  if tp.status <> 'pending' then return jsonb_build_object('error', 'Already ' || tp.status || '.'); end if;
  if p_approve then
    update public.team_photos set status = 'replaced' where status = 'approved' and id <> tp.id
       and ((tp.person is not null and person = tp.person) or names && tp.names);
    update public.team_photos set status = 'approved', decided_by = public.my_email(), decided_at = now() where id = tp.id;
  else
    update public.team_photos set status = 'rejected', decided_by = public.my_email(), decided_at = now(), why = nullif(left(trim(coalesce(p_why, '')), 200), '') where id = tp.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.team_photo_decide(bigint, boolean, text) from public, anon;
grant execute on function public.team_photo_decide(bigint, boolean, text) to authenticated;

-- 038's client_team, now with each person's approved photo
create or replace function public.client_team(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; f jsonb; fam boolean; desk boolean; today date := (now() at time zone 'Asia/Kolkata')::date; out jsonb := '[]'::jsonb;
begin
  select * into l from public.client_links where token = p_token and active;
  if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  fam := public.my_email() <> '' and public.my_email() = any(l.emails); desk := public.is_desk();
  if not (fam or desk) then return jsonb_build_object('error', 'Only the family''s registered Gmail can see this.'); end if;
  select data into f from public.client_feed where wedding_key = l.wedding_key;
  if f is null or jsonb_typeof(f -> 'team') <> 'object' then return jsonb_build_object('functions', out, 'opens', 'the day before'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', fn ->> 'id', 'name', fn ->> 'name', 'date', fn ->> 'date', 'slot', fn ->> 'slot',
           'team', (select coalesce(jsonb_agg(jsonb_build_object('name', left(t ->> 'name', 60), 'role', left(coalesce(t ->> 'role', ''), 60),
                                                                'phone', left(regexp_replace(coalesce(t ->> 'phone', ''), '[^0-9+ ]', '', 'g'), 20),
                                                                'photo', (select tp.upload from public.team_photos tp join public.uploads u on u.id = tp.upload
                                                                           where tp.status = 'approved' and u.status = 'ok' and u.removed_at is null and lower(trim(t ->> 'name')) = any(tp.names)
                                                                           order by tp.decided_at desc limit 1))), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(f -> 'team' -> (fn ->> 'id'), '[]'::jsonb)) t where coalesce(t ->> 'name', '') <> ''))
         order by fn ->> 'date', fn ->> 'slot'), '[]'::jsonb) into out
    from jsonb_array_elements(coalesce(f -> 'functions', '[]'::jsonb)) fn
   where (fn ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
     and (fn ->> 'date')::date >= today and (desk or (fn ->> 'date')::date <= today + 1);
  return jsonb_build_object('functions', out, 'preview', desk and not fam);
end $$;
revoke all on function public.client_team(uuid) from public, anon;
grant execute on function public.client_team(uuid) to authenticated;

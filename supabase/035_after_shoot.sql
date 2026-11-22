-- 035 (23 Nov 2026, Ravi: "Add after shoot options on client's page (Delivery, Payment status, I tick which services need to be
-- delivered, update payment status which sends request to owner or manager to approve which allows them access to see deliveries)").
-- Run after 034 (and run 031 again: client_rename now also moves these two tables).
-- Decided with Ravi (23 Nov 2026):
--   · deliveries = the services the admin / manager ticks for a client (from the package items, or typed), each with a status
--     (waiting / editing / ready / delivered) and a link (Drive, gallery…) that the studio pastes when it is ready;
--   · the family sees the list and the status at any time, but the LINKS open only when approved payments reach 90 % of the
--     package total; the admin / manager can open (or keep closed) a client by hand. The itinerary is never locked for money.
--   · the family reports a payment ("we paid": amount, date, mode, UPI ref, optional screenshot on the studio's Google Drive);
--     the admin or the manager approves it (it becomes a normal payment in Package & payments) or rejects it with a reason.

-- ── what is delivered ──
create table if not exists public.client_deliveries (
  id          uuid primary key default gen_random_uuid(),
  wedding_key text not null check (length(wedding_key) between 1 and 200),
  kind        text check (length(kind) <= 40),                       -- the package item kind (reel, album…) or null when typed
  title       text not null check (length(title) between 1 and 80),
  status      text not null default 'waiting' check (status in ('waiting', 'editing', 'ready', 'delivered')),
  link        text check (link is null or (length(link) <= 600 and link ~* '^https?://')),
  note        text check (length(note) <= 300),
  sort        smallint not null default 0,
  updated_by  text not null default public.my_email(),
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists client_deliveries_w on public.client_deliveries (wedding_key, sort);
create or replace function public.client_deliveries_by() returns trigger language plpgsql as $$
begin new.updated_by := public.my_email(); new.updated_at := now(); return new; end $$;
drop trigger if exists client_deliveries_by on public.client_deliveries;
create trigger client_deliveries_by before insert or update on public.client_deliveries for each row execute function public.client_deliveries_by();
alter table public.client_deliveries enable row level security;
drop policy if exists cdel_all on public.client_deliveries;
create policy cdel_all on public.client_deliveries for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists cdel_read on public.client_deliveries;
create policy cdel_read on public.client_deliveries for select to authenticated using (public.is_desk());
revoke all on public.client_deliveries from anon;
grant select, insert, update, delete on public.client_deliveries to authenticated;

-- open / closed by hand: null = by payment (90 %), true = opened by hand, false = kept closed by hand
alter table public.client_links add column if not exists deliveries_open boolean;

-- ── payments the family reports ──
create table if not exists public.client_pay_claims (
  id          uuid primary key default gen_random_uuid(),
  wedding_key text not null check (length(wedding_key) between 1 and 200),
  amount      numeric not null check (amount > 0 and amount < 100000000),
  paid_on     date not null,
  mode        text not null default 'UPI' check (mode in ('Cash', 'UPI', 'Bank', 'Cheque', 'Other')),
  upi_ref     text check (length(upi_ref) <= 60),
  note        text check (length(note) <= 200),
  photo       uuid,                                                   -- uploads.id (purpose 'pay'), when the screenshot went to Drive
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  by_email    text not null,
  at          timestamptz not null default now(),
  decided_by  text,
  decided_at  timestamptz,
  why         text check (length(why) <= 200),
  payment     uuid                                                    -- booking_payments.id made by the approval
);
create index if not exists client_pay_claims_w on public.client_pay_claims (wedding_key, at desc);
create index if not exists client_pay_claims_p on public.client_pay_claims (status) where status = 'pending';
alter table public.client_pay_claims enable row level security;
drop policy if exists cpay_read on public.client_pay_claims;
create policy cpay_read on public.client_pay_claims for select to authenticated using (public.is_staff() or public.is_payroll());
revoke all on public.client_pay_claims from anon, authenticated;
grant select on public.client_pay_claims to authenticated;    -- written only through the functions below

-- is this client's delivery open? (by hand, else approved payments ≥ 90 % of the package total)
create or replace function public.deliveries_open(p_key text) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(
    (select l.deliveries_open from public.client_links l where l.wedding_key = p_key and l.deliveries_open is not null limit 1),
    (select b.total > 0 and coalesce((select sum(p.amount) from public.booking_payments p where p.wedding_key = b.wedding_key), 0) >= b.total * 0.9
       from public.bookings b where b.wedding_key = p_key),
    false) $$;
revoke all on function public.deliveries_open(text) from public, anon;

-- the family page (or the studio's preview): deliveries, payment status and the family's own payment reports
create or replace function public.client_after(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; b public.bookings; fam boolean; isopen boolean; paid numeric := 0; manual boolean;
begin
  select * into l from public.client_links where token = p_token and active;
  if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  fam := public.my_email() <> '' and public.my_email() = any(l.emails);
  if not (fam or public.is_desk()) then return jsonb_build_object('error', 'Only the family''s registered Gmail can see this.'); end if;
  select * into b from public.bookings where wedding_key = l.wedding_key;
  select coalesce(sum(amount), 0) into paid from public.booking_payments where wedding_key = l.wedding_key;
  isopen := public.deliveries_open(l.wedding_key); manual := l.deliveries_open is not null;
  return jsonb_build_object(
    'open', isopen, 'by_hand', manual, 'total', coalesce(b.total, 0), 'paid', paid,
    'need', case when coalesce(b.total, 0) > 0 then greatest(ceil(b.total * 0.9) - paid, 0) else null end,
    'can_claim', fam and b.wedding_key is not null,
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'kind', d.kind, 'status', d.status, 'note', d.note,
        'has_link', d.link is not null, 'link', case when isopen or public.is_desk() then d.link end, 'at', d.updated_at) order by d.sort, d.created_at)
      from public.client_deliveries d where d.wedding_key = l.wedding_key), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'amount', x.amount, 'paid_on', x.paid_on, 'mode', x.mode, 'upi_ref', x.upi_ref,
        'status', x.status, 'why', x.why, 'at', x.at) order by x.at desc)
      from public.client_pay_claims x where x.wedding_key = l.wedding_key), '[]'::jsonb));
end $$;
revoke all on function public.client_after(uuid) from public, anon;
grant execute on function public.client_after(uuid) to authenticated;

-- the family: "we paid"
create or replace function public.client_pay_claim(p_token uuid, p_amount numeric, p_paid_on date, p_mode text, p_ref text, p_note text, p_photo uuid)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.client_links; n int; id uuid; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into l from public.client_links where token = p_token and active;
  if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not (public.my_email() <> '' and public.my_email() = any(l.emails)) then return jsonb_build_object('error', 'Only the family''s registered Gmail can report a payment.'); end if;
  if not exists (select 1 from public.bookings where wedding_key = l.wedding_key) then return jsonb_build_object('error', 'Muto''s has not added your package yet. Please call us.'); end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 100000000 then return jsonb_build_object('error', 'Type the amount you paid.'); end if;
  if p_paid_on is null or p_paid_on > today or p_paid_on < today - 400 then return jsonb_build_object('error', 'Pick the date you paid.'); end if;
  if coalesce(p_mode, 'UPI') not in ('Cash', 'UPI', 'Bank', 'Cheque', 'Other') then return jsonb_build_object('error', 'Pick how you paid.'); end if;
  select count(*) into n from public.client_pay_claims where wedding_key = l.wedding_key and status = 'pending';
  if n >= 10 then return jsonb_build_object('error', 'Muto''s is still checking your earlier payments. Please wait or call us.'); end if;
  if p_photo is not null and to_regclass('public.uploads') is not null and not exists (
      select 1 from public.uploads u where u.id = p_photo and u.wedding_key = l.wedding_key and u.purpose = 'pay') then
    return jsonb_build_object('error', 'That screenshot is not on this booking.'); end if;
  insert into public.client_pay_claims (wedding_key, amount, paid_on, mode, upi_ref, note, photo, by_email)
    values (l.wedding_key, round(p_amount, 2), p_paid_on, coalesce(p_mode, 'UPI'), nullif(left(trim(coalesce(p_ref, '')), 60), ''),
            nullif(left(trim(coalesce(p_note, '')), 200), ''), p_photo, public.my_email())
    returning client_pay_claims.id into id;
  return jsonb_build_object('ok', true, 'id', id, 'title', l.title);
end $$;
revoke all on function public.client_pay_claim(uuid, numeric, date, text, text, text, uuid) from public, anon;
grant execute on function public.client_pay_claim(uuid, numeric, date, text, text, text, uuid) to authenticated;

-- admin / manager: approve (it becomes a payment in Package & payments) or reject with a reason
create or replace function public.client_pay_decide(p_claim uuid, p_approve boolean, p_why text, p_amount numeric)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare x public.client_pay_claims; pid uuid; amt numeric;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can approve a payment.'); end if;
  select * into x from public.client_pay_claims where id = p_claim for update;
  if x.id is null then return jsonb_build_object('error', 'Unknown payment.'); end if;
  if x.status <> 'pending' then return jsonb_build_object('error', 'Already ' || x.status || '.'); end if;
  if coalesce(p_approve, false) then
    if not exists (select 1 from public.bookings where wedding_key = x.wedding_key) then return jsonb_build_object('error', 'Add the client''s package first (Package & payments).'); end if;
    amt := coalesce(p_amount, x.amount);
    if amt <= 0 or amt >= 100000000 then return jsonb_build_object('error', 'Amount?'); end if;
    insert into public.booking_payments (wedding_key, amount, paid_on, mode, note)
      values (x.wedding_key, round(amt, 2), x.paid_on, x.mode, left('Family reported' || coalesce(' · ref ' || x.upi_ref, '') || coalesce(' · ' || x.note, '') ||
              case when amt <> x.amount then ' · they wrote ' || x.amount else '' end, 200))
      returning booking_payments.id into pid;
    update public.client_pay_claims set status = 'approved', decided_by = public.my_email(), decided_at = now(), payment = pid,
      why = nullif(left(trim(coalesce(p_why, '')), 200), '') where id = x.id;
  else
    if length(trim(coalesce(p_why, ''))) < 3 then return jsonb_build_object('error', 'Write why, so the family knows.'); end if;
    update public.client_pay_claims set status = 'rejected', decided_by = public.my_email(), decided_at = now(), why = left(trim(p_why), 200) where id = x.id;
  end if;
  if to_regclass('public.client_log') is not null then
    insert into public.client_log (event_id, wedding, kind, what)
      select f ->> 'id', coalesce(l.title, x.wedding_key), 'payment',
             left(case when p_approve then 'Payment of ₹' || coalesce(p_amount, x.amount) || ' reported by the family approved by ' else 'Payment of ₹' || x.amount || ' reported by the family rejected by ' end || public.me_label(), 600)
      from public.client_feed cf cross join lateral jsonb_array_elements(coalesce(cf.data -> 'functions', '[]'::jsonb)) f
      left join public.client_links l on l.wedding_key = cf.wedding_key
      where cf.wedding_key = x.wedding_key limit 1;
  end if;
  return jsonb_build_object('ok', true, 'open', public.deliveries_open(x.wedding_key));
end $$;
revoke all on function public.client_pay_decide(uuid, boolean, text, numeric) from public, anon;
grant execute on function public.client_pay_decide(uuid, boolean, text, numeric) to authenticated;

-- admin / manager: open or close a client's deliveries by hand (null = back to the 90 % rule)
create or replace function public.client_deliveries_set_open(p_key text, p_open boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can do this.'); end if;
  if not exists (select 1 from public.client_links where wedding_key = p_key) then return jsonb_build_object('error', 'Add the family''s Gmail first.'); end if;
  update public.client_links set deliveries_open = p_open where wedding_key = p_key;
  return jsonb_build_object('ok', true, 'open', public.deliveries_open(p_key));
end $$;
revoke all on function public.client_deliveries_set_open(text, boolean) from public, anon;
grant execute on function public.client_deliveries_set_open(text, boolean) to authenticated;

-- payment screenshots go to the studio's Google Drive like the other family photos (026), only when 026 is in this database.
-- A screenshot is seen by the family and the admin / manager / accountant only (never by the crew, never the supervisor).
do $do$
begin
  if to_regclass('public.uploads') is null then raise notice '026_photos.sql not run yet: payment screenshots are off until it is.'; return; end if;
  alter table public.uploads drop constraint if exists uploads_purpose_check;
  alter table public.uploads add constraint uploads_purpose_check check (purpose in ('card', 'vip', 'ref', 'pay'));
  execute $f$
  create or replace function public.upload_sees(u public.uploads) returns boolean
    language sql stable security definer set search_path = public as $s$
    select case when u.kind = 'card' then public.is_card_desk() or public.my_person() is not null
                when u.purpose = 'pay' then public.is_staff() or public.is_payroll()
                  or exists (select 1 from public.client_links l where l.wedding_key = u.wedding_key and l.active and public.my_email() <> '' and public.my_email() = any(l.emails))
                else public.upload_sees_wedding(u.wedding_key) end $s$ $f$;
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
    else
      return jsonb_build_object('error', 'Unknown photo type.');
    end if;
    return jsonb_build_object('id', id, 'folder', to_jsonb(folder), 'name', fname);
  end $b$ $f$;
end $do$;

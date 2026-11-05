-- Muto's app · Packages, bookings and payments (6 Nov 2026). Run after 008_drives.sql.
--
-- packages          the studio's packages: price and what is delivered (Reel per function, Trailer, Full film, LR edit, Album …)
-- bookings          one per wedding (same wedding_key as the board/Clients): package, deliverables (editable), total, payment plan, lock rule
-- booking_payments  money received (append-only for managers; only the owner deletes a wrong entry)
-- The client page shows the package and payments; when a payment is overdue (past its date + grace days) and the lock is on,
-- the family can still see everything but cannot change their details (client_save refuses) until it is paid. Only the studio can.
-- NOTE: client_get / client_save are redefined here (from 005). The parked phone sign-in (006, branch wip-phone-otp) also redefines them:
-- merge both when the phone sign-in comes back.

create table if not exists public.packages (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 80),
  price      numeric not null default 0 check (price >= 0),
  items      jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),   -- [{ kind, per: 'wedding'|'function', qty?, note? }]
  notes      text check (length(notes) <= 500),
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index if not exists packages_name_uq on public.packages (lower(trim(name)));
drop trigger if exists packages_touch on public.packages;
create trigger packages_touch before update on public.packages for each row execute function public.touch_updated_at();

create table if not exists public.bookings (
  wedding_key  text primary key check (length(wedding_key) <= 200),
  title        text not null check (length(title) <= 120),
  package_id   uuid references public.packages(id) on delete set null,
  package_name text check (length(package_name) <= 80),
  items        jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  total        numeric not null default 0 check (total >= 0),
  plan         jsonb not null default '[]' check (jsonb_typeof(plan) = 'array'),    -- [{ label, due: 'YYYY-MM-DD', amount }]
  lock_on      boolean not null default true,
  grace_days   smallint not null default 3 check (grace_days between 0 and 60),
  notes        text check (length(notes) <= 1000),
  created_by   text not null default public.my_email(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
drop trigger if exists bookings_touch on public.bookings;
create trigger bookings_touch before update on public.bookings for each row execute function public.touch_updated_at();

create table if not exists public.booking_payments (
  id          uuid primary key default gen_random_uuid(),
  wedding_key text not null references public.bookings(wedding_key) on delete cascade on update cascade,
  amount      numeric not null check (amount > 0),
  paid_on     date not null default ((now() at time zone 'Asia/Kolkata')::date),
  mode        text not null default 'UPI' check (mode in ('Cash', 'UPI', 'Bank', 'Cheque', 'Other')),
  note        text check (length(note) <= 200),
  by_email    text not null default public.my_email(),
  at          timestamptz not null default now()
);
create index if not exists booking_payments_w on public.booking_payments (wedding_key);
create or replace function public.payment_by() returns trigger language plpgsql as $$
begin new.by_email := public.my_email(); new.at := now(); return new; end $$;
drop trigger if exists payment_by on public.booking_payments;
create trigger payment_by before insert on public.booking_payments for each row execute function public.payment_by();

-- money summary of one wedding: what is paid, what is due by today, the next due date, and whether the client page is locked
create or replace function public.booking_summary(p_key text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare b public.bookings; paid numeric; due_now numeric; late numeric; nxt record; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not (public.is_staff() or public.is_payroll() or exists (select 1 from public.client_links where wedding_key = p_key and active and public.my_email() <> '' and public.my_email() = any(emails))) then return null; end if;
  select * into b from public.bookings where wedding_key = p_key;
  if not found then return null; end if;
  select coalesce(sum(amount), 0) into paid from public.booking_payments where wedding_key = p_key;
  select coalesce(sum((x ->> 'amount')::numeric), 0) into due_now from jsonb_array_elements(b.plan) x where (x ->> 'due')::date <= today;
  select coalesce(sum((x ->> 'amount')::numeric), 0) into late from jsonb_array_elements(b.plan) x where (x ->> 'due')::date + b.grace_days < today;
  -- the next instalment not yet covered by what was paid
  select x ->> 'label' as label, (x ->> 'due')::date as due, (x ->> 'amount')::numeric as amount into nxt
  from (select x, sum((x ->> 'amount')::numeric) over (order by (x ->> 'due')::date, x ->> 'label') as upto from jsonb_array_elements(b.plan) x) s
  where upto > paid order by (x ->> 'due')::date limit 1;
  return jsonb_build_object('package', b.package_name, 'items', b.items, 'total', b.total, 'paid', paid, 'pending', greatest(b.total - paid, 0),
    'due_now', greatest(due_now - paid, 0), 'next_label', nxt.label, 'next_due', nxt.due, 'next_amount', case when nxt.due is null then null else least(nxt.amount, greatest(b.total - paid, 0)) end,
    'locked', b.lock_on and late - paid > 0, 'overdue', greatest(late - paid, 0));
end $$;

-- ── client page: now also shows the package and payments, and respects the lock ──
create or replace function public.client_get(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; f jsonb; i public.client_itinerary;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not (public.my_email() = any(l.emails) or public.is_staff()) then
    return jsonb_build_object('error', 'This Gmail (' || coalesce(nullif(public.my_email(), ''), 'not signed in') || ') is not on Muto''s list for this wedding.', 'not_listed', true);
  end if;
  select data into f from public.client_feed where wedding_key = l.wedding_key;
  select * into i from public.client_itinerary where wedding_key = l.wedding_key;
  return jsonb_build_object('title', l.title, 'functions', coalesce(f -> 'functions', '[]'::jsonb), 'answers', coalesce(i.data, '{}'::jsonb), 'submitted_at', i.submitted_at,
    'preview', not (public.my_email() = any(l.emails)), 'booking', public.booking_summary(l.wedding_key));
end $$;

create or replace function public.client_save(p_token uuid, p_data jsonb, p_submit boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare l public.client_links; s jsonb;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not (public.my_email() <> '' and public.my_email() = any(l.emails)) then return jsonb_build_object('error', 'Only the family''s registered Gmail can fill this in.'); end if;
  s := public.booking_summary(l.wedding_key);
  if s is not null and (s ->> 'locked')::boolean then
    return jsonb_build_object('error', 'Your details are locked until the pending payment of ₹' || to_char((s ->> 'overdue')::numeric, 'FM99,99,99,999') || ' is cleared. Please call Muto''s.', 'locked', true);
  end if;
  -- room for small photos of the family's important people (each photo is shrunk on the phone first)
  if p_data is null or jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 1500000 then return jsonb_build_object('error', 'Too much to save. Remove a few photos or shorten the notes.'); end if;
  insert into public.client_itinerary as c (wedding_key, data, submitted_at, updated_at)
  values (l.wedding_key, p_data, case when p_submit then now() end, now())
  on conflict (wedding_key) do update set data = excluded.data, updated_at = now(),
    submitted_at = case when p_submit then now() else c.submitted_at end;
  return jsonb_build_object('ok', true, 'saved_at', now());
end $$;
revoke all on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean), public.booking_summary(text) from public, anon;
grant execute on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean) to authenticated;
grant execute on function public.booking_summary(text) to authenticated;

-- ── access rules ────────────────────────────────────────────────────────
alter table public.packages enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_payments enable row level security;
drop policy if exists pk_select on public.packages;
create policy pk_select on public.packages for select to authenticated using (public.is_staff() or public.is_payroll());
drop policy if exists pk_write on public.packages;
create policy pk_write on public.packages for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists bk_select on public.bookings;
create policy bk_select on public.bookings for select to authenticated using (public.is_staff() or public.is_payroll());
drop policy if exists bk_write on public.bookings;
create policy bk_write on public.bookings for all to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists bp_select on public.booking_payments;
create policy bp_select on public.booking_payments for select to authenticated using (public.is_staff() or public.is_payroll());
drop policy if exists bp_insert on public.booking_payments;
create policy bp_insert on public.booking_payments for insert to authenticated with check (public.is_staff());
drop policy if exists bp_delete on public.booking_payments;
create policy bp_delete on public.booking_payments for delete to authenticated using (public.is_owner());
revoke all on public.packages, public.bookings, public.booking_payments from anon, authenticated;
grant select, insert, update, delete on public.packages, public.bookings to authenticated;
grant select, insert, delete on public.booking_payments to authenticated;

-- a starting set of packages to edit (names and prices are placeholders: change them in Clients → Packages)
insert into public.packages (name, price, items, notes)
select * from (values
  ('Basic (edit me)', 0::numeric, '[{"kind":"top","per":"wedding"},{"kind":"lr","per":"wedding"},{"kind":"trailer","per":"wedding"}]'::jsonb, 'Placeholder: set the real price and deliverables'),
  ('Premium (edit me)', 0::numeric, '[{"kind":"reel","per":"function"},{"kind":"trailer","per":"wedding"},{"kind":"full","per":"wedding"},{"kind":"top","per":"wedding"},{"kind":"lr","per":"wedding"},{"kind":"album_sel","per":"wedding"},{"kind":"album","per":"wedding","qty":40,"note":"40 sheets"}]'::jsonb, 'Placeholder: set the real price and deliverables')
) as v(name, price, items, notes)
where not exists (select 1 from public.packages);

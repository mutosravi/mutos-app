-- 041 (23 Nov 2026, Ravi: "I want you to build everything on this app only. I do not want to continue working on mybillbook.
-- Build Sales desk … Adding a party, their quotation, services, prices … bank accounts … live balance and transactions …
-- a different sub-desk for gst billing … connected to the same bank accounts." Run after 040 (works without 026–040 too).
-- Decided 23 Nov: one business (Muto's Films), ONE register; each bill is a plain bill (invoice) or a GST invoice (gst_invoice);
-- the GST view lists only GST invoices. Banks: Ravi types each account's current balance once, then every payment in / out /
-- expense / transfer recorded here moves it. Expenses, purchases and payments out move too. Only admin + manager (is_staff()).
-- Nothing is ever deleted: documents and payments are cancelled with a reason, and every change is written to sales_log.

-- ── settings: the business on the bills, terms, number series ───────────────────────────────────────────────────────
create table if not exists public.sales_settings (
  id   int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);
insert into public.sales_settings (id, data) values (1, jsonb_build_object(
  'name', 'Muto''s Films', 'state', 'Uttar Pradesh', 'website', 'www.mutosstudio.com',
  'address', 'Muto''s Tower, D-2/26, Vibhuti Khand, Gomti Nagar, Lucknow, Uttar Pradesh 226010',
  'pay_terms', '30% Booking Amount; 60% Before Event; 10% During Final Delivery',
  'quote_days', 15)) on conflict (id) do nothing;

create table if not exists public.sales_series (
  kind   text primary key check (kind in ('quotation', 'invoice', 'gst_invoice', 'purchase', 'in', 'out', 'expense', 'transfer')),
  prefix text not null default '' check (length(prefix) <= 30),
  next   bigint not null default 1 check (next > 0)
);
-- continues myBillBook's numbering (Ravi can change prefix / next number in Settings)
insert into public.sales_series (kind, prefix, next) values
  ('quotation', 'MTF2026-', 27245), ('invoice', 'MF/SL/26-27/', 157), ('gst_invoice', 'MF/G/26-27/', 21),
  ('purchase', 'PUR-', 1), ('in', 'IN-', 231), ('out', 'OUT-', 82), ('expense', 'EXP-', 341), ('transfer', 'TR-', 1)
on conflict (kind) do nothing;

create or replace function public.sales_next(p_kind text) returns text
  language plpgsql security definer set search_path = public as $$
declare s public.sales_series;
begin
  update public.sales_series set next = next + 1 where kind = p_kind returning * into s;
  if s.kind is null then raise exception 'Unknown number series %', p_kind; end if;
  return s.prefix || (s.next - 1)::text;
end $$;
revoke all on function public.sales_next(text) from public, anon, authenticated;

-- ── services and goods (the price list) ────────────────────────────────────────────────────────────────────────────
create table if not exists public.sale_items (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) between 1 and 120),
  kind         text not null default 'service' check (kind in ('service', 'good')),
  tier         text check (tier in ('standard', 'premium')),          -- packages: Standard and Premium are never mixed on one bill
  category     text check (length(category) <= 60),
  unit         text not null default 'SSN' check (length(unit) between 1 and 12),
  price        numeric not null default 0 check (price >= 0),          -- before GST
  gst_rate     numeric not null default 18 check (gst_rate in (0, 5, 12, 18, 28)),  -- used only on a GST invoice
  sac          text check (length(sac) <= 12),
  team         text check (length(team) <= 400),                       -- who goes (shown under the line)
  deliverables text check (length(deliverables) <= 600),
  hours        numeric check (hours > 0 and hours <= 48),
  active       boolean not null default true,
  sort         int not null default 0,
  updated_at   timestamptz not null default now()
);
create unique index if not exists sale_items_name_uq on public.sale_items (lower(trim(name)));

-- ── parties (customers and vendors) ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.parties (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  kind        text not null default 'customer' check (kind in ('customer', 'vendor', 'both')),
  phone       text check (length(phone) <= 20),
  email       text check (length(email) <= 120),
  gstin       text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  address     text check (length(address) <= 300),
  state       text check (length(state) <= 40),
  wedding_key text check (length(wedding_key) <= 200),                 -- the client on the board (Clients window)
  opening     numeric not null default 0,                              -- + they owed us, − we owed them, when moved here
  notes       text check (length(notes) <= 500),
  active      boolean not null default true,
  created_by  text not null default public.my_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists parties_name on public.parties (lower(name));

-- ── quotations, bills, GST invoices, purchases ──────────────────────────────────────────────────────────────────────
create table if not exists public.sales_docs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('quotation', 'invoice', 'gst_invoice', 'purchase')),
  number      text not null default '' check (length(number) <= 40),
  doc_date    date not null default ((now() at time zone 'Asia/Kolkata')::date),
  due_date    date,
  party       uuid not null references public.parties(id),
  wedding_key text check (length(wedding_key) <= 200),
  title       text check (length(title) <= 120),
  -- [{ item, name, desc, event, date, place, hours, deliverables, qty, unit, rate, disc, gst }]  (disc = % off the line)
  lines       jsonb not null default '[]' check (jsonb_typeof(lines) = 'array'),
  subtotal    numeric not null default 0,      -- before discounts
  discount    numeric not null default 0,
  taxable     numeric not null default 0,
  cgst        numeric not null default 0,
  sgst        numeric not null default 0,
  igst        numeric not null default 0,
  round_off   numeric not null default 0,
  total       numeric not null default 0,
  paid        numeric not null default 0,      -- payments allocated to it (kept by money_txns)
  terms       text check (length(terms) <= 4000),
  pay_terms   text check (length(pay_terms) <= 300),
  notes       text check (length(notes) <= 1000),
  supply_state text check (length(supply_state) <= 40),
  status      text not null default 'open' check (status in ('open', 'converted', 'cancelled')),
  from_doc    uuid references public.sales_docs(id),
  token       text not null default replace(gen_random_uuid()::text, '-', ''),   -- share link
  cancel_why  text check (length(cancel_why) <= 200),
  created_by  text not null default public.my_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists sales_docs_number on public.sales_docs (kind, number) where number <> '';
create unique index if not exists sales_docs_token on public.sales_docs (token);
create index if not exists sales_docs_party on public.sales_docs (party);
create index if not exists sales_docs_date on public.sales_docs (doc_date);

-- ── money: bank / cash accounts and every payment ───────────────────────────────────────────────────────────────────
create table if not exists public.bank_accounts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 60),
  kind       text not null default 'bank' check (kind in ('bank', 'cash')),
  bank       text check (length(bank) <= 60),
  acc_no     text check (acc_no is null or acc_no ~ '^[0-9]{6,20}$'),  -- the studio's own account, printed on bills so families can pay
  ifsc       text check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  upi        text check (length(upi) <= 60),
  opening    numeric not null default 0,                             -- the balance Ravi typed …
  opening_on date not null default ((now() at time zone 'Asia/Kolkata')::date),   -- … on this day
  on_bills   boolean not null default false,                         -- print these bank details on bills
  active     boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.money_txns (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('in', 'out', 'expense', 'transfer')),
  number      text not null default '' check (length(number) <= 40),
  txn_date    date not null default ((now() at time zone 'Asia/Kolkata')::date),
  amount      numeric not null check (amount > 0),
  account     uuid not null references public.bank_accounts(id),
  to_account  uuid references public.bank_accounts(id),             -- transfer only
  party       uuid references public.parties(id),
  category    text check (length(category) <= 60),                   -- expenses
  mode        text not null default 'UPI' check (mode in ('Cash', 'UPI', 'Bank', 'Cheque', 'Card', 'Other')),
  ref         text check (length(ref) <= 60),
  note        text check (length(note) <= 300),
  gst         numeric not null default 0 check (gst >= 0),           -- GST inside an expense (for the GST view)
  alloc       jsonb not null default '[]' check (jsonb_typeof(alloc) = 'array'),   -- [{ doc, amount }]
  booking_payment uuid,                                              -- the copy on the client's booking (009)
  status      text not null default 'ok' check (status in ('ok', 'cancelled')),
  cancel_why  text check (length(cancel_why) <= 200),
  created_by  text not null default public.my_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (kind <> 'transfer' or (to_account is not null and to_account <> account))
);
create unique index if not exists money_txns_number on public.money_txns (kind, number) where number <> '';
create index if not exists money_txns_date on public.money_txns (txn_date);
create index if not exists money_txns_party on public.money_txns (party);

create table if not exists public.sales_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  by_email text not null default public.my_email(),
  what     text not null,
  ref_kind text,
  ref_id   uuid
);

-- ── rules ───────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.sales_round(n numeric) returns numeric language sql immutable as $$ select round(coalesce(n, 0), 2) $$;

-- a document's numbers always come from its lines (nobody types a total)
create or replace function public.sales_docs_rules() returns trigger
  language plpgsql security definer set search_path = public as $$
declare l jsonb; q numeric; r numeric; d numeric; g numeric; amt numeric; disc numeric; tax numeric;
  sub numeric := 0; dis numeric := 0; txb numeric := 0; tx numeric := 0; home text; st text; tiers text[];
begin
  if tg_op = 'UPDATE' then
    new.id := old.id; new.kind := old.kind; new.token := old.token; new.created_by := old.created_by; new.created_at := old.created_at;
    if new.number is distinct from old.number and old.number <> '' and not public.is_owner() then new.number := old.number; end if;
    if old.status = 'cancelled' then raise exception 'This one is cancelled. Make a new one.'; end if;
    if new.status = 'cancelled' and coalesce(trim(new.cancel_why), '') = '' then raise exception 'Write why it is cancelled.'; end if;
    if new.status = 'cancelled' and old.paid > 0 then raise exception 'Payments are linked to it. Cancel or move those payments first.'; end if;
  else
    new.paid := 0; new.status := 'open'; new.cancel_why := null; new.created_by := public.my_email(); new.created_at := now();
    if coalesce(new.number, '') = '' then new.number := public.sales_next(new.kind); end if;
  end if;
  if jsonb_array_length(new.lines) > 200 then raise exception 'Too many lines.'; end if;
  select array_agg(distinct x ->> 'tier') into tiers from jsonb_array_elements(new.lines) x where coalesce(x ->> 'tier', '') <> '';
  if coalesce(array_length(tiers, 1), 0) > 1 then raise exception 'Standard and Premium packages cannot be on one bill.'; end if;
  home := coalesce((select data ->> 'state' from public.sales_settings where id = 1), 'Uttar Pradesh');
  st := coalesce(nullif(new.supply_state, ''), (select nullif(state, '') from public.parties where id = new.party), home);
  new.supply_state := st;
  for l in select * from jsonb_array_elements(new.lines) loop
    q := coalesce((l ->> 'qty')::numeric, 1); r := coalesce((l ->> 'rate')::numeric, 0); d := least(greatest(coalesce((l ->> 'disc')::numeric, 0), 0), 100);
    g := case when new.kind = 'gst_invoice' or (new.kind = 'purchase' and coalesce((l ->> 'gst')::numeric, 0) > 0) then coalesce((l ->> 'gst')::numeric, 18) else 0 end;
    if q <= 0 or r < 0 then raise exception 'Each line needs a quantity and a price.'; end if;
    amt := q * r; disc := amt * d / 100; tax := (amt - disc) * g / 100;
    sub := sub + amt; dis := dis + disc; txb := txb + amt - disc; tx := tx + tax;
  end loop;
  new.subtotal := sales_round(sub); new.discount := sales_round(dis); new.taxable := sales_round(txb);
  if tx > 0 and lower(st) <> lower(home) then new.igst := sales_round(tx); new.cgst := 0; new.sgst := 0;
  else new.cgst := sales_round(tx / 2); new.sgst := sales_round(tx / 2); new.igst := 0; end if;
  new.round_off := round(txb + tx) - (new.taxable + new.cgst + new.sgst + new.igst);
  new.total := round(txb + tx);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists sales_docs_rules on public.sales_docs;
create trigger sales_docs_rules before insert or update on public.sales_docs for each row execute function public.sales_docs_rules();

-- an invoice made from a quotation marks the quotation converted
create or replace function public.sales_docs_after() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.lines = old.lines and new.total = old.total and new.status = old.status and new.number = old.number
     and new.doc_date = old.doc_date and new.party = old.party then return null; end if;   -- only "paid" or a note changed
  if tg_op = 'INSERT' and new.from_doc is not null and new.kind <> 'quotation' then
    update public.sales_docs set status = 'converted' where id = new.from_doc and kind = 'quotation' and status = 'open';
  end if;
  insert into public.sales_log (what, ref_kind, ref_id) values (
    case when tg_op = 'INSERT' then 'Made ' || new.kind || ' ' || new.number || ' · ₹' || new.total
         when new.status = 'cancelled' and old.status <> 'cancelled' then 'Cancelled ' || new.kind || ' ' || new.number || ': ' || new.cancel_why
         when new.status = 'converted' and old.status = 'open' then 'Converted quotation ' || new.number
         else 'Changed ' || new.kind || ' ' || new.number || case when new.total <> old.total then ' · ₹' || old.total || ' → ₹' || new.total else '' end end,
    'doc', new.id);
  return null;
end $$;
drop trigger if exists sales_docs_after on public.sales_docs;
create trigger sales_docs_after after insert or update on public.sales_docs for each row execute function public.sales_docs_after();

-- what is paid on each document = the live payments allocated to it
create or replace function public.sales_recount(p_docs uuid[]) returns void
  language plpgsql security definer set search_path = public as $$
declare d record;
begin
  for d in select s.id, s.total, s.number, (select coalesce(sum((a ->> 'amount')::numeric), 0) from public.money_txns m, jsonb_array_elements(m.alloc) a
             where m.status = 'ok' and (a ->> 'doc')::uuid = s.id) as p
             from public.sales_docs s where s.id = any(p_docs) loop
    if d.p > d.total + 0.5 then raise exception 'More than the bill % (₹%) would be paid.', d.number, d.total; end if;
    update public.sales_docs set paid = d.p where id = d.id and paid <> d.p;
  end loop;
end $$;
revoke all on function public.sales_recount(uuid[]) from public, anon, authenticated;
-- (sales_docs_rules keeps "paid" as it was on any other update; sales_recount runs as the owner of the function)
-- paid always = the live payments allocated to it (nobody types it); a bill cannot be cut below what is already paid
create or replace function public.sales_docs_paid_ok() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.paid := (select coalesce(sum((a ->> 'amount')::numeric), 0) from public.money_txns m, jsonb_array_elements(m.alloc) a
                where m.status = 'ok' and (a ->> 'doc')::uuid = new.id);
  if new.paid > new.total + 0.5 then raise exception 'Already ₹% paid on %: the bill cannot be less than that.', new.paid, new.number; end if;
  return new;
end $$;
drop trigger if exists sales_docs_zpaid on public.sales_docs;
create trigger sales_docs_zpaid before insert or update on public.sales_docs for each row execute function public.sales_docs_paid_ok();

create or replace function public.money_rules() returns trigger
  language plpgsql security definer set search_path = public as $$
declare a jsonb; doc public.sales_docs; tot numeric := 0; want text[];
begin
  if tg_op = 'UPDATE' then
    new.id := old.id; new.kind := old.kind; new.created_by := old.created_by; new.created_at := old.created_at;
    if pg_trigger_depth() = 1 then new.booking_payment := old.booking_payment; end if;
    if new.number is distinct from old.number and old.number <> '' and not public.is_owner() then new.number := old.number; end if;
    if old.status = 'cancelled' then raise exception 'This payment is cancelled. Record a new one.'; end if;
    if new.status = 'cancelled' and coalesce(trim(new.cancel_why), '') = '' then raise exception 'Write why it is cancelled.'; end if;
  else
    new.status := 'ok'; new.cancel_why := null; new.created_by := public.my_email(); new.created_at := now(); new.booking_payment := null;
    if coalesce(new.number, '') = '' then new.number := public.sales_next(new.kind); end if;
  end if;
  if new.kind <> 'transfer' then new.to_account := null; end if;
  if new.kind = 'transfer' then new.party := null; new.alloc := '[]'; end if;
  if new.kind = 'expense' and coalesce(trim(new.category), '') = '' then raise exception 'Pick what the expense was for.'; end if;
  if new.party is null and jsonb_array_length(new.alloc) > 0 then raise exception 'Pick the party.'; end if;
  want := case new.kind when 'in' then array['invoice', 'gst_invoice'] when 'out' then array['purchase'] when 'expense' then array['purchase'] else array[]::text[] end;
  for a in select * from jsonb_array_elements(new.alloc) loop
    select * into doc from public.sales_docs where id = (a ->> 'doc')::uuid;
    if doc.id is null or not (doc.kind = any(want)) then raise exception 'A payment can only go against the right kind of bill.'; end if;
    if doc.status = 'cancelled' then raise exception 'Bill % is cancelled.', doc.number; end if;
    if new.party is distinct from doc.party then raise exception 'Bill % belongs to another party.', doc.number; end if;
    if coalesce((a ->> 'amount')::numeric, 0) <= 0 then raise exception 'Each linked bill needs an amount.'; end if;
    tot := tot + (a ->> 'amount')::numeric;
  end loop;
  if tot > new.amount + 0.001 then raise exception 'Linked bills add up to more than the payment.'; end if;
  if not exists (select 1 from public.bank_accounts where id = new.account) then raise exception 'Pick the account.'; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists money_rules on public.money_txns;
create trigger money_rules before insert or update on public.money_txns for each row execute function public.money_rules();

-- after a payment: bills' paid amounts, the client's booking (family page / 90 % rule), the log
create or replace function public.money_after() returns trigger
  language plpgsql security definer set search_path = public as $$
declare docs uuid[]; wk text; bp uuid; pname text; acc text;
begin
  select array_agg(distinct (a ->> 'doc')::uuid) into docs from (
    select jsonb_array_elements(new.alloc) a union all select jsonb_array_elements(case when tg_op = 'UPDATE' then old.alloc else '[]'::jsonb end)) x;
  if docs is not null then perform public.sales_recount(docs); end if;
  -- money from a client with a booking also shows on their booking (009), so the family page and the 90 % rule follow
  if new.kind = 'in' and to_regclass('public.booking_payments') is not null then
    select p.wedding_key into wk from public.parties p where p.id = new.party;
    if tg_op = 'INSERT' and new.status = 'ok' and wk is not null and exists (select 1 from public.bookings where wedding_key = wk) then
      insert into public.booking_payments (wedding_key, amount, paid_on, mode, note)
        values (wk, new.amount, new.txn_date, case when new.mode in ('Cash', 'UPI', 'Bank', 'Cheque') then new.mode else 'Other' end, left('Sales desk ' || new.number || coalesce(' · ' || new.ref, ''), 200))
        returning id into bp;
      update public.money_txns set booking_payment = bp where id = new.id;
    elsif tg_op = 'UPDATE' and old.booking_payment is not null and (new.status = 'cancelled' or new.amount <> old.amount or new.txn_date <> old.txn_date) then
      if new.status = 'cancelled' then delete from public.booking_payments where id = old.booking_payment;
      else update public.booking_payments set amount = new.amount, paid_on = new.txn_date where id = old.booking_payment; end if;
    end if;
  end if;
  select name into pname from public.parties where id = new.party;
  select name into acc from public.bank_accounts where id = new.account;
  if pg_trigger_depth() = 1 then
    insert into public.sales_log (what, ref_kind, ref_id) values (
      case when tg_op = 'INSERT' then 'Recorded ' || new.kind || ' ' || new.number || ' · ₹' || new.amount || coalesce(' · ' || pname, '') || ' · ' || coalesce(acc, '')
           when new.status = 'cancelled' and old.status <> 'cancelled' then 'Cancelled ' || new.kind || ' ' || new.number || ': ' || new.cancel_why
           else 'Changed ' || new.kind || ' ' || new.number || case when new.amount <> old.amount then ' · ₹' || old.amount || ' → ₹' || new.amount else '' end end,
      'money', new.id);
  end if;
  return null;
end $$;
drop trigger if exists money_after on public.money_txns;
create trigger money_after after insert or update on public.money_txns for each row execute function public.money_after();

create or replace function public.sales_touch_log() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and tg_table_name = 'bank_accounts' and (new.opening <> old.opening or new.opening_on <> old.opening_on) then
    insert into public.sales_log (what, ref_kind, ref_id) values ('Opening balance of ' || new.name || ': ₹' || old.opening || ' (' || old.opening_on || ') → ₹' || new.opening || ' (' || new.opening_on || ')', 'account', new.id);
  elsif tg_op = 'UPDATE' and tg_table_name = 'parties' and new.opening <> old.opening then
    insert into public.sales_log (what, ref_kind, ref_id) values ('Opening balance of ' || new.name || ': ₹' || old.opening || ' → ₹' || new.opening, 'party', new.id);
  end if;
  return new;
end $$;
drop trigger if exists bank_accounts_touch on public.bank_accounts;
create trigger bank_accounts_touch before update on public.bank_accounts for each row execute function public.sales_touch_log();
drop trigger if exists parties_touch on public.parties;
create trigger parties_touch before update on public.parties for each row execute function public.sales_touch_log();
drop trigger if exists sale_items_touch on public.sale_items;
create trigger sale_items_touch before update on public.sale_items for each row execute function public.touch_updated_at();

-- ── balances ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- each account: the typed balance + everything recorded from that day on
create or replace function public.bank_balances() returns table (id uuid, name text, kind text, balance numeric, last_txn date)
  language sql stable security definer set search_path = public as $$
  select b.id, b.name, b.kind,
         b.opening + coalesce((select sum(case when m.kind = 'in' then m.amount when m.kind = 'transfer' and m.to_account = b.id then m.amount else -m.amount end)
                                 from public.money_txns m where m.status = 'ok' and m.txn_date >= b.opening_on
                                  and (m.account = b.id or (m.kind = 'transfer' and m.to_account = b.id))), 0),
         (select max(m.txn_date) from public.money_txns m where m.status = 'ok' and (m.account = b.id or m.to_account = b.id))
    from public.bank_accounts b where public.is_staff() order by b.sort, b.name
$$;
revoke all on function public.bank_balances() from public, anon;
grant execute on function public.bank_balances() to authenticated;

-- each party: + = they owe us, − = we owe them
create or replace function public.party_balances() returns table (id uuid, balance numeric, billed numeric, received numeric, last_date date)
  language sql stable security definer set search_path = public as $$
  select p.id,
         p.opening
         + coalesce((select sum(total) from public.sales_docs where party = p.id and kind in ('invoice', 'gst_invoice') and status <> 'cancelled'), 0)
         - coalesce((select sum(total) from public.sales_docs where party = p.id and kind = 'purchase' and status <> 'cancelled'), 0)
         - coalesce((select sum(amount) from public.money_txns where party = p.id and kind = 'in' and status = 'ok'), 0)
         + coalesce((select sum(amount) from public.money_txns where party = p.id and kind in ('out', 'expense') and status = 'ok'), 0),
         coalesce((select sum(total) from public.sales_docs where party = p.id and kind in ('invoice', 'gst_invoice') and status <> 'cancelled'), 0),
         coalesce((select sum(amount) from public.money_txns where party = p.id and kind = 'in' and status = 'ok'), 0),
         greatest((select max(doc_date) from public.sales_docs where party = p.id), (select max(txn_date) from public.money_txns where party = p.id))
    from public.parties p where public.is_staff()
$$;
revoke all on function public.party_balances() from public, anon;
grant execute on function public.party_balances() to authenticated;

-- ── the share link: a family / company opens one bill without signing in ────────────────────────────────────────────
create or replace function public.sales_doc_view(p_token text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare d public.sales_docs; p public.parties; s jsonb; banks jsonb;
begin
  if coalesce(length(p_token), 0) < 20 then return jsonb_build_object('error', 'Not found.'); end if;
  select * into d from public.sales_docs where token = p_token and kind in ('quotation', 'invoice', 'gst_invoice');
  if d.id is null or d.status = 'cancelled' then return jsonb_build_object('error', 'This link is not valid any more. Please ask Muto''s.'); end if;
  select * into p from public.parties where id = d.party;
  select data into s from public.sales_settings where id = 1;
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'bank', bank, 'acc_no', acc_no, 'ifsc', ifsc, 'upi', upi) order by sort, name), '[]'::jsonb) into banks
    from public.bank_accounts where on_bills and active and kind = 'bank';
  return jsonb_build_object(
    'kind', d.kind, 'number', d.number, 'doc_date', d.doc_date, 'due_date', d.due_date, 'title', d.title, 'lines', d.lines,
    'subtotal', d.subtotal, 'discount', d.discount, 'taxable', d.taxable, 'cgst', d.cgst, 'sgst', d.sgst, 'igst', d.igst,
    'round_off', d.round_off, 'total', d.total, 'paid', case when d.kind = 'quotation' then 0 else d.paid end,
    'terms', d.terms, 'pay_terms', d.pay_terms, 'notes', d.notes, 'supply_state', d.supply_state, 'status', d.status,
    'party', jsonb_build_object('name', p.name, 'gstin', p.gstin, 'address', p.address, 'state', p.state),
    'company', (s - 'quote_days') || jsonb_build_object('gstin', case when d.kind = 'gst_invoice' then s ->> 'gstin' end), 'banks', banks);
end $$;
revoke all on function public.sales_doc_view(text) from public;
grant execute on function public.sales_doc_view(text) to anon, authenticated;

-- ── access: admin + manager only; nothing is deleted ────────────────────────────────────────────────────────────────
do $$ declare t text; begin
  foreach t in array array['sales_settings', 'sales_series', 'sale_items', 'parties', 'sales_docs', 'bank_accounts', 'money_txns', 'sales_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.is_staff()) with check (public.is_staff())', t || '_staff', t);
  end loop;
end $$;
grant select, insert, update on public.sale_items, public.parties, public.sales_docs, public.bank_accounts, public.money_txns to authenticated;
grant select, update on public.sales_settings, public.sales_series to authenticated;
grant select on public.sales_log to authenticated;
grant usage, select on sequence public.sales_log_id_seq to authenticated;

-- ── the price list to start with: Muto's booklet 2026 + myBillBook's albums (Ravi, 23 Nov: short events are 5 hours) ──
insert into public.sale_items (name, tier, category, unit, price, team, deliverables, hours, sort) values
 ('Wedding (Standard)', 'standard', 'Wedding', 'SSN', 180000, '2 Candid Photographers, 1 Wide Photographer, 2 Cinematographers, 1 Wide Videographer, 1 Aerial',
  '1 Trailer video (1080p), 2 Vertical short videos, 1 Full length video (1080p), 100 Edited and retouched photographs, All raw data (if HDD/SSD provided)', null, 10),
 ('Engagement/Sangeet/Reception (Standard)', 'standard', 'Function', 'SSN', 55000, '1 Candid Photographer, 1 Wide Photographer, 1 Cinematographer, 1 Wide Videographer',
  '1 Trailer video (1080p), 1 Vertical short video, 1 Full length video (1080p), 50 Edited and retouched photographs, All raw data (if HDD/SSD provided)', null, 20),
 ('Short Event (Standard)', 'standard', 'Short event', 'SSN', 15000, '1 Candid Photographer, 1 Cinematographer',
  '1 Vertical short video, 1 Full length video, 25 Edited and retouched photographs, All raw data (if HDD/SSD provided)', 5, 30),
 ('Wedding (Premium)', 'premium', 'Wedding', 'SSN', 260000, '2 Candid Photographers, 1 Wide Photographer, 2 Cinematographers, 1 Wide Videographer, 1 Aerial, 1 Director',
  '1 Wedding film, 1 Teaser, 3 Vertical short videos, 1 Full length cinematic video (4K HDR), 150 Edited and retouched photographs, 5 Instagram carousels, All raw data; couple and family interview', null, 40),
 ('Engagement/Sangeet/Reception (Premium)', 'premium', 'Function', 'SSN', 70000, '2 Candid Photographers, 2 Cinematographers, 1 Director',
  '1 Trailer video, 1 Vertical short video, 1 Full length cinematic video (4K HDR), 50 Edited and retouched photographs, 2 Instagram carousels, All raw data', null, 50),
 ('Short Event (Premium)', 'premium', 'Short event', 'SSN', 24000, '1 Candid Photographer, 1 Cinematographer',
  '1 Vertical short video, 1 Full length cinematic video (4K HDR), 25 Edited and retouched photographs, 1 Instagram carousel, All raw data', 5, 60),
 ('Pre-wedding Photo Shoot', 'standard', 'Pre-wedding', 'SSN', 25000, null, '2 Sessions of outdoor/indoor photoshoot, 50 Edited and retouched photographs, All raw photographs', null, 70),
 ('Pre-wedding Film', 'standard', 'Pre-wedding', 'SSN', 40000, null, '4 Sessions of outdoor/indoor videography, 1 Pre-wedding film, 1 Short vertical video', null, 71),
 ('Pre-wedding Combined', 'standard', 'Pre-wedding', 'SSN', 60000, null, '3 Sessions of photo and video shoot, 60 Edited and retouched photographs, 1 Pre-wedding film, 1 Short vertical video, All raw photographs', null, 72),
 ('Pre-wedding Film (Premium)', 'premium', 'Pre-wedding', 'SSN', 75000, 'Director and team', '4 Sessions of video shoot, Pre-production by director, Shot in 4K HDR, 1 Pre-wedding film, 1 Short vertical video', null, 73),
 ('Khat', null, 'Khat', 'SSN', 45000, 'Director and team', 'Pre-shoot meetings with director, 2-3 sessions of video interviews, Data retrieval from client''s archives, Shot in 4K HDR, 1 Documentary style film', null, 80),
 ('Khat (with screening)', null, 'Khat', 'SSN', 80000, 'Director and team', 'Everything in Khat, plus screening on an LED wall', null, 81),
 ('Album 30 Sheets', null, 'Album', 'PCS', 12000, null, 'Page options: Matt / Velvet / Glossy / Luster / Texture. Cover options: all without box.', null, 90),
 ('Album 50 Sheets', null, 'Album', 'PCS', 20000, null, 'Page options: Matt / Velvet / Glossy / Luster / Texture. Cover options: all without box.', null, 91),
 ('Jib + 4 LED TV', null, 'Add-on', 'SSN', 15000, null, null, null, 100),
 ('Jib + LED Wall (12''x8'')', null, 'Add-on', 'SSN', 20000, null, null, null, 101),
 ('On the spot printing', null, 'Add-on', 'SSN', 30000, null, null, null, 102),
 ('Same day edit', null, 'Add-on', 'SSN', 20000, null, null, null, 103),
 ('Drone Service', null, 'Add-on', 'SSN', 8000, '1 Aerial', null, null, 104),
 ('Selfie Booth', null, 'Add-on', 'SSN', 15000, null, '₹15,000–50,000 depending on the booth', null, 105),
 ('Dedicated Manager', null, 'Add-on', 'SSN', 10000, null, null, null, 106),
 ('Video Interview Session', null, 'Add-on', 'SSN', 25000, null, '2 hours', 2, 107),
 ('Photo Frame', null, 'Add-on', 'PCS', 1200, null, 'From ₹1,200', null, 108),
 ('Extra hour (per person)', null, 'Extra', 'HRS', 2000, null, 'Shooting beyond the contract hours', null, 120)
on conflict do nothing;

-- the 20 terms from Muto's quotations (Ravi can edit them in Settings); point 4 now says 5 hours (Ravi, 23 Nov)
update public.sales_settings set data = data || jsonb_build_object('terms', $t$1- For outstation events, client will arrange/pay for travel, food, stay & delivery SSD unless included in package. Raw data must be collected within 3 months.
2- Extra shooting beyond contract hours/days will be charged ₹2,000 per hour per person.
3- Client must provide correct call time; delays due to wrong timing are not our responsibility.
4- Short Event like Haldi, Mehndi, Eng, Sangeet coverage means maximum 5 hours; additional events or extensions are chargeable.
5- Trailer & soft copies delivered in 30–45 days; full video/album delivered ~30 days after photo selection and payment.
6- Editing may be handled by the same team for quality consistency; minor delays may occur in peak season.
7- Cancellation/modification requires 3 months notice; refund 90% of booking amount minus expenses.
8- Studio keeps backups but not liable for technical loss; uncollected data may be deleted after 3 months.
9- Timely payment is mandatory or shoot/delivery may be paused.
10- Misbehavior with team leads to immediate shoot termination without refund; report issues only to management.
11- Valid government ID required at booking.
12- Laser lights can damage cameras; if not informed, cameras may be stopped and missed moments not our responsibility.
13- Vidaai coverage valid till 8 AM; extra hours charged ₹2,000/hr/person; home entry not included unless booked.
14- Drone flying depends on location permissions and pilot discretion.
15- After final delivery & payment, data deleted in 7 days; download links expire in 7 days and won't be reshared.
16- If raw data required, client must provide 2TB SSD 15 days before event; returned at final delivery.
17- Soft deliverables via Google Drive link, counted as final; not re-shared later.
18- Albums/Hard drives (if in contract) given physically/courier.
19- Studio not liable once deliverables are handed over.
20- All disputes under Lucknow jurisdiction.$t$) where id = 1 and not (data ? 'terms');

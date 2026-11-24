-- 042 (24 Nov 2026, Ravi: "can we connect invoices with clients so their deliveries automatically gets feed there?").
-- Run after 041 (needs 035 for the deliveries; without 035 only the payment part is skipped too).
-- Decided with Ravi (24 Nov 2026):
--   · a BILL (plain or GST invoice, not a quotation) of a client on the board fills the client's "Services to deliver"
--     (After shoot, the family's "Your photos & films"): one line per deliverable written on the bill, e.g.
--     "Haldi: 1 Trailer video (1080p)", status Not started. Things already listed for the client are not added twice.
--     Editing the bill adds new deliverables and takes away the ones no longer on it, but only while nobody has touched them
--     (still Not started, no link, no note). Cancelling the bill takes its untouched ones away. Unticked in After shoot = gone
--     until that deliverable is newly written on a bill again.
--   · the package total (Package & payments, the 90 % rule) stays typed by hand; the bill does not change it.
--   · approving a payment the family reported can also record it in the Sales desk: a Payment In into the account picked,
--     set against the client's oldest unpaid bills (their party is made when they have none), so the bank balance follows.
--     The family's package gets ONE payment (the Sales desk bridge of 041 makes it; nothing is counted twice).

-- ── 1. deliverables of a bill → the client's services to deliver ──
do $do$
begin
  if to_regclass('public.client_deliveries') is null then raise notice '035_after_shoot.sql not run yet: bills fill deliveries once it is.'; return; end if;
  alter table public.client_deliveries add column if not exists from_doc uuid;      -- the bill this line came from (042)
  create index if not exists client_deliveries_doc on public.client_deliveries (from_doc) where from_doc is not null;
end $do$;

-- "1 Trailer video (1080p), 2 Vertical short videos; All raw data (if HDD/SSD provided)" → one title each, with the function in front
create or replace function public.sales_deliv_titles(p_lines jsonb) returns table (title text, n int)
  language sql immutable set search_path = public as $$
  select t, min(n)::int from (
    select left(case when pre <> '' then pre || ': ' else '' end || part, 80) as t, (l.n * 100 + p.m)::int as n
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality l(x, n)
    cross join lateral (select trim(regexp_replace(coalesce(nullif(trim(l.x ->> 'event'), ''), l.x ->> 'name', ''), '\s*\((standard|premium)\)\s*$', '', 'i')) as pre) q
    cross join lateral regexp_split_to_table(coalesce(l.x ->> 'deliverables', ''), '\s*([,;\n·]|\s-\s)\s*(?![^(]*\))') with ordinality p(raw, m)
    cross join lateral (select btrim(trim(p.raw), '.') as part) r
    where r.part <> ''
  ) s where length(t) > 0 group by t order by min(n)
$$;

create or replace function public.sales_deliv_apply(p_doc uuid, p_old_lines jsonb, p_old_key text) returns void
  language plpgsql security definer set search_path = public as $$
declare d public.sales_docs; wk text; base int;
begin
  if to_regclass('public.client_deliveries') is null then return; end if;
  select * into d from public.sales_docs where id = p_doc;
  if d.id is null or d.kind not in ('invoice', 'gst_invoice') then return; end if;
  wk := coalesce(nullif(d.wedding_key, ''), (select nullif(wedding_key, '') from public.parties where id = d.party));
  -- untouched lines of this bill that should not be there any more (cancelled, another client, or no longer written on it)
  delete from public.client_deliveries c
   where c.from_doc = d.id and c.status = 'waiting' and c.link is null and c.note is null
     and (d.status = 'cancelled' or wk is null or c.wedding_key <> wk
          or lower(c.title) not in (select lower(t.title) from public.sales_deliv_titles(d.lines) t));
  if d.status = 'cancelled' or wk is null then return; end if;
  select coalesce(max(sort), -1) + 1 into base from public.client_deliveries where wedding_key = wk;
  insert into public.client_deliveries (wedding_key, kind, title, sort, from_doc)
  select wk, 'bill', t.title, least(base + (row_number() over (order by t.n))::int - 1, 32000), d.id
    from public.sales_deliv_titles(d.lines) t
   where (p_old_lines is null or p_old_key is distinct from wk
          or lower(t.title) not in (select lower(o.title) from public.sales_deliv_titles(p_old_lines) o))
     and not exists (select 1 from public.client_deliveries c where c.wedding_key = wk and lower(c.title) = lower(t.title));
end $$;
revoke all on function public.sales_deliv_apply(uuid, jsonb, text) from public, anon, authenticated;

create or replace function public.sales_docs_deliv() returns trigger
  language plpgsql security definer set search_path = public as $$
declare oldk text;
begin
  if new.kind not in ('invoice', 'gst_invoice') then return null; end if;
  if tg_op = 'UPDATE' then
    if new.lines = old.lines and new.status = old.status and new.wedding_key is not distinct from old.wedding_key and new.party = old.party then return null; end if;
    oldk := coalesce(nullif(old.wedding_key, ''), (select nullif(wedding_key, '') from public.parties where id = old.party));
    perform public.sales_deliv_apply(new.id, case when old.status = 'cancelled' then null else old.lines end, oldk);
  else
    perform public.sales_deliv_apply(new.id, null, null);
  end if;
  return null;
end $$;
drop trigger if exists sales_docs_deliv on public.sales_docs;
create trigger sales_docs_deliv after insert or update on public.sales_docs for each row execute function public.sales_docs_deliv();

-- once: bills already made for a client on the board
do $do$
declare r record; n int := 0;
begin
  if to_regclass('public.client_deliveries') is null then return; end if;
  for r in select d.id from public.sales_docs d left join public.parties p on p.id = d.party
            where d.kind in ('invoice', 'gst_invoice') and d.status <> 'cancelled' and coalesce(nullif(d.wedding_key, ''), nullif(p.wedding_key, '')) is not null
              and not exists (select 1 from public.client_deliveries c where c.from_doc = d.id)
            order by d.doc_date, d.created_at loop
    perform public.sales_deliv_apply(r.id, null, null); n := n + 1;
  end loop;
  raise notice 'deliveries filled from % bill(s)', n;
end $do$;

-- ── 2. approving a family's payment also records it in the Sales desk ──
do $do$
begin
  if to_regclass('public.client_pay_claims') is null then raise notice '035_after_shoot.sql not run yet: nothing to change for family payments.'; return; end if;
  alter table public.client_pay_claims add column if not exists txn uuid;           -- money_txns.id made by the approval (042)
  drop function if exists public.client_pay_decide(uuid, boolean, text, numeric);
  execute $f$
  create or replace function public.client_pay_decide(p_claim uuid, p_approve boolean, p_why text, p_amount numeric, p_account uuid default null)
    returns jsonb language plpgsql security definer set search_path = public as $s$
  declare x public.client_pay_claims; pid uuid; amt numeric; pty uuid; tid uuid; tno text; left_ numeric; al jsonb := '[]'; b record; ttl text;
  begin
    if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can approve a payment.'); end if;
    select * into x from public.client_pay_claims where id = p_claim for update;
    if x.id is null then return jsonb_build_object('error', 'Unknown payment.'); end if;
    if x.status <> 'pending' then return jsonb_build_object('error', 'Already ' || x.status || '.'); end if;
    if coalesce(p_approve, false) then
      if not exists (select 1 from public.bookings where wedding_key = x.wedding_key) then return jsonb_build_object('error', 'Add the client''s package first (Package & payments).'); end if;
      amt := round(coalesce(p_amount, x.amount), 2);
      if amt <= 0 or amt >= 100000000 then return jsonb_build_object('error', 'Amount?'); end if;
      if p_account is not null then
        if not exists (select 1 from public.bank_accounts where id = p_account and active) then return jsonb_build_object('error', 'Pick the account the money came into.'); end if;
        select id into pty from public.parties where wedding_key = x.wedding_key and active order by created_at limit 1;
        if pty is null then
          select coalesce(nullif(l.title, ''), regexp_replace(x.wedding_key, '^[a-z]:', '')) into ttl from (select 1) o left join public.client_links l on l.wedding_key = x.wedding_key;
          insert into public.parties (name, kind, wedding_key, notes) values (left(ttl, 120), 'customer', x.wedding_key, 'Made when a family payment was approved')
            returning id into pty;
        end if;
        left_ := amt;     -- against the oldest unpaid bills first
        for b in select id, total - paid as due from public.sales_docs
                  where party = pty and kind in ('invoice', 'gst_invoice') and status <> 'cancelled' and total - paid > 0
                  order by doc_date, created_at loop
          exit when left_ <= 0;
          al := al || jsonb_build_array(jsonb_build_object('doc', b.id, 'amount', least(left_, b.due)));
          left_ := left_ - least(left_, b.due);
        end loop;
        insert into public.money_txns (kind, txn_date, amount, account, party, mode, ref, note, alloc)
          values ('in', x.paid_on, amt, p_account, pty, x.mode, left(x.upi_ref, 60), left('Family reported on their page' || coalesce(' · ' || x.note, ''), 300), al)
          returning id into tid;
        select number, booking_payment into tno, pid from public.money_txns where id = tid;   -- the 041 bridge made the package payment
        if pid is not null then
          update public.booking_payments set note = left('Family reported · ' || tno || coalesce(' · ref ' || x.upi_ref, '') || coalesce(' · ' || x.note, '') ||
                 case when amt <> x.amount then ' · they wrote ' || x.amount else '' end, 200) where id = pid;
        end if;
      end if;
      if pid is null then
        insert into public.booking_payments (wedding_key, amount, paid_on, mode, note)
          values (x.wedding_key, amt, x.paid_on, x.mode, left('Family reported' || coalesce(' · ref ' || x.upi_ref, '') || coalesce(' · ' || x.note, '') ||
                  case when amt <> x.amount then ' · they wrote ' || x.amount else '' end, 200))
          returning booking_payments.id into pid;
      end if;
      update public.client_pay_claims set status = 'approved', decided_by = public.my_email(), decided_at = now(), payment = pid, txn = tid,
        why = nullif(left(trim(coalesce(p_why, '')), 200), '') where id = x.id;
    else
      if length(trim(coalesce(p_why, ''))) < 3 then return jsonb_build_object('error', 'Write why, so the family knows.'); end if;
      update public.client_pay_claims set status = 'rejected', decided_by = public.my_email(), decided_at = now(), why = left(trim(p_why), 200) where id = x.id;
    end if;
    if to_regclass('public.client_log') is not null then
      insert into public.client_log (event_id, wedding, kind, what)
        select f ->> 'id', coalesce(l.title, x.wedding_key), 'payment',
               left(case when p_approve then 'Payment of ₹' || coalesce(amt, x.amount) || ' reported by the family approved by ' else 'Payment of ₹' || x.amount || ' reported by the family rejected by ' end || public.me_label() ||
                    case when tno is not null then ' (Sales desk ' || tno || ')' else '' end, 600)
        from public.client_feed cf cross join lateral jsonb_array_elements(coalesce(cf.data -> 'functions', '[]'::jsonb)) f
        left join public.client_links l on l.wedding_key = cf.wedding_key
        where cf.wedding_key = x.wedding_key limit 1;
    end if;
    return jsonb_build_object('ok', true, 'open', public.deliveries_open(x.wedding_key), 'txn', tno);
  end $s$;
  $f$;
  revoke all on function public.client_pay_decide(uuid, boolean, text, numeric, uuid) from public, anon;
  grant execute on function public.client_pay_decide(uuid, boolean, text, numeric, uuid) to authenticated;
end $do$;

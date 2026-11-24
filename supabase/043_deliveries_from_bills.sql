-- 043 (24 Nov 2026, Ravi: "Most of the clients have already paid 90% amount and it is already there in transactions. Now it is not
-- showing in their deliveries"). Run after 042.
-- Decided with Ravi (24 Nov 2026): the Sales desk counts too.
--   · a client's deliveries open when EITHER the package (Package & payments, as before) OR the client's bills in the Sales desk are
--     90 % paid (bills of a party linked to the client, or bills made for the client; cancelled bills left out). Open / closed by hand
--     still wins.
--   · the family page shows the numbers that opened it, else the bills when there are any, else the package.
--   · a family with bills but no package can also tell Muto's "We paid"; approving it then needs an account (it goes into the Sales
--     desk only, since there is no package to add it to).
--   · linking a myBillBook party to its board client is done in the Sales desk (Parties → "Link to board clients").

-- fix for 041: changing a party failed ("record new has no field opening_on"), so a party could not be edited or linked
create or replace function public.sales_touch_log() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  -- one table at a time: plpgsql cannot even look at new.opening_on on a party (it has none), so the checks must not share one line
  if tg_op = 'UPDATE' and tg_table_name = 'bank_accounts' then
    if new.opening <> old.opening or new.opening_on <> old.opening_on then
      insert into public.sales_log (what, ref_kind, ref_id) values ('Opening balance of ' || new.name || ': ₹' || old.opening || ' (' || old.opening_on || ') → ₹' || new.opening || ' (' || new.opening_on || ')', 'account', new.id);
    end if;
  elsif tg_op = 'UPDATE' and tg_table_name = 'parties' then
    if new.opening <> old.opening then
      insert into public.sales_log (what, ref_kind, ref_id) values ('Opening balance of ' || new.name || ': ₹' || old.opening || ' → ₹' || new.opening, 'party', new.id);
    end if;
  end if;
  return new;
end $$;

-- what the Sales desk says for a client: bills total and paid
create or replace function public.client_bills_money(p_key text) returns table (total numeric, paid numeric, bills int)
  language sql stable security definer set search_path = public as $$
  select coalesce(sum(d.total), 0), coalesce(sum(d.paid), 0), count(*)::int
    from public.sales_docs d left join public.parties p on p.id = d.party
   where d.kind in ('invoice', 'gst_invoice') and d.status <> 'cancelled'
     and coalesce(nullif(d.wedding_key, ''), p.wedding_key) = p_key
$$;
revoke all on function public.client_bills_money(text) from public, anon, authenticated;

-- both sides at once; source = 'bills' / 'package' / null (the one that opened it, else bills, else package)
create or replace function public.client_money_of(p_key text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare b public.bookings; ppaid numeric := 0; bt numeric; bp numeric; bn int; pk_open boolean; bl_open boolean; manual boolean; src text;
begin
  select * into b from public.bookings where wedding_key = p_key;
  select coalesce(sum(amount), 0) into ppaid from public.booking_payments where wedding_key = p_key;
  select m.total, m.paid, m.bills into bt, bp, bn from public.client_bills_money(p_key) m;
  pk_open := coalesce(b.total, 0) > 0 and ppaid >= b.total * 0.9;
  bl_open := bt > 0 and bp >= bt * 0.9;
  select l.deliveries_open into manual from public.client_links l where l.wedding_key = p_key and l.deliveries_open is not null limit 1;
  src := case when bl_open then 'bills' when pk_open then 'package' when bt > 0 then 'bills' when b.wedding_key is not null then 'package' end;
  return jsonb_build_object('open', coalesce(manual, pk_open or bl_open), 'by_hand', manual is not null, 'source', src,
    'pkg_total', coalesce(b.total, 0), 'pkg_paid', ppaid, 'has_package', b.wedding_key is not null,
    'bills_total', bt, 'bills_paid', bp, 'bills', bn,
    'total', case src when 'bills' then bt when 'package' then coalesce(b.total, 0) else 0 end,
    'paid', case src when 'bills' then bp when 'package' then ppaid else 0 end);
end $$;
revoke all on function public.client_money_of(text) from public, anon, authenticated;

create or replace function public.deliveries_open(p_key text) returns boolean
  language sql stable security definer set search_path = public as $$ select (public.client_money_of(p_key) ->> 'open')::boolean $$;
revoke all on function public.deliveries_open(text) from public, anon;

-- the studio's view of one client (After shoot window)
create or replace function public.client_money(p_key text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can see this.'); end if;
  return public.client_money_of(p_key) || jsonb_build_object('parties', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
    from public.parties where wedding_key = p_key and active), '[]'::jsonb));
end $$;
revoke all on function public.client_money(text) from public, anon;
grant execute on function public.client_money(text) to authenticated;

-- the family page: same as 035, the money now from client_money_of
create or replace function public.client_after(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; fam boolean; m jsonb; isopen boolean; tot numeric; pd numeric;
begin
  select * into l from public.client_links where token = p_token and active;
  if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  fam := public.my_email() <> '' and public.my_email() = any(l.emails);
  if not (fam or public.is_desk()) then return jsonb_build_object('error', 'Only the family''s registered Gmail can see this.'); end if;
  m := public.client_money_of(l.wedding_key); isopen := (m ->> 'open')::boolean; tot := (m ->> 'total')::numeric; pd := (m ->> 'paid')::numeric;
  return jsonb_build_object(
    'open', isopen, 'by_hand', (m ->> 'by_hand')::boolean, 'total', tot, 'paid', pd, 'source', m ->> 'source',
    'need', case when tot > 0 then greatest(ceil(tot * 0.9) - pd, 0) else null end,
    'can_claim', fam and ((m ->> 'has_package')::boolean or (m ->> 'bills')::int > 0),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'kind', d.kind, 'status', d.status, 'note', d.note,
        'has_link', d.link is not null, 'link', case when isopen or public.is_desk() then d.link end, 'at', d.updated_at) order by d.sort, d.created_at)
      from public.client_deliveries d where d.wedding_key = l.wedding_key), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'amount', x.amount, 'paid_on', x.paid_on, 'mode', x.mode, 'upi_ref', x.upi_ref,
        'status', x.status, 'why', x.why, 'at', x.at) order by x.at desc)
      from public.client_pay_claims x where x.wedding_key = l.wedding_key), '[]'::jsonb));
end $$;
revoke all on function public.client_after(uuid) from public, anon;
grant execute on function public.client_after(uuid) to authenticated;

-- the family: "we paid" — also when there are bills but no package
create or replace function public.client_pay_claim(p_token uuid, p_amount numeric, p_paid_on date, p_mode text, p_ref text, p_note text, p_photo uuid)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.client_links; n int; id uuid; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into l from public.client_links where token = p_token and active;
  if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not (public.my_email() <> '' and public.my_email() = any(l.emails)) then return jsonb_build_object('error', 'Only the family''s registered Gmail can report a payment.'); end if;
  if not exists (select 1 from public.bookings where wedding_key = l.wedding_key) and (select bills from public.client_bills_money(l.wedding_key)) = 0 then
    return jsonb_build_object('error', 'Muto''s has not added your package yet. Please call us.'); end if;
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

-- approving: as 042, but a client with bills and no package can be approved into the Sales desk (an account is then needed)
create or replace function public.client_pay_decide(p_claim uuid, p_approve boolean, p_why text, p_amount numeric, p_account uuid default null)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare x public.client_pay_claims; pid uuid; amt numeric; pty uuid; tid uuid; tno text; left_ numeric; al jsonb := '[]'; b record; ttl text; haspkg boolean;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can approve a payment.'); end if;
  select * into x from public.client_pay_claims where id = p_claim for update;
  if x.id is null then return jsonb_build_object('error', 'Unknown payment.'); end if;
  if x.status <> 'pending' then return jsonb_build_object('error', 'Already ' || x.status || '.'); end if;
  if coalesce(p_approve, false) then
    haspkg := exists (select 1 from public.bookings where wedding_key = x.wedding_key);
    if not haspkg and p_account is null then
      return jsonb_build_object('error', case when (select bills from public.client_bills_money(x.wedding_key)) > 0
        then 'This client has no package: pick the account the money came into (it goes into the Sales desk).'
        else 'Add the client''s package first (Package & payments).' end); end if;
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
      select number, booking_payment into tno, pid from public.money_txns where id = tid;   -- the 041 bridge made the package payment (when there is a package)
      if pid is not null then
        update public.booking_payments set note = left('Family reported · ' || tno || coalesce(' · ref ' || x.upi_ref, '') || coalesce(' · ' || x.note, '') ||
               case when amt <> x.amount then ' · they wrote ' || x.amount else '' end, 200) where id = pid;
      end if;
    end if;
    if pid is null and haspkg then
      insert into public.booking_payments (wedding_key, amount, paid_on, mode, note)
        values (x.wedding_key, amt, x.paid_on, x.mode, left('Family reported' || coalesce(' · ' || tno, '') || coalesce(' · ref ' || x.upi_ref, '') || coalesce(' · ' || x.note, '') ||
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
end $$;
revoke all on function public.client_pay_decide(uuid, boolean, text, numeric, uuid) from public, anon;
grant execute on function public.client_pay_decide(uuid, boolean, text, numeric, uuid) to authenticated;

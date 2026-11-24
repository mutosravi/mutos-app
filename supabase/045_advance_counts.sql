-- 045 (24 Nov 2026, Ravi: "Payment updated in parties but it did not show in clients after shoot"). Run after 044.
-- A Payment In saved from a party WITHOUT setting it against a bill ("Against bills" left empty) is an advance: the bill's paid
-- stays the same, so 043's 90 % rule did not see it. Now the money side of a client also counts the part of every live
-- Payment In of a party linked to that client (parties.wedding_key) that is not set against any bill.
-- Nothing in the accounts changes; the party balance was already right.
create or replace function public.client_bills_money(p_key text) returns table (total numeric, paid numeric, bills int)
  language sql stable security definer set search_path = public as $$
  with b as (
    select coalesce(sum(d.total), 0) as total, coalesce(sum(d.paid), 0) as paid, count(*)::int as n
      from public.sales_docs d left join public.parties p on p.id = d.party
     where d.kind in ('invoice', 'gst_invoice') and d.status <> 'cancelled'
       and coalesce(nullif(d.wedding_key, ''), p.wedding_key) = p_key),
  adv as (
    select coalesce(sum(greatest(t.amount - coalesce((select sum((a ->> 'amount')::numeric) from jsonb_array_elements(t.alloc) a), 0), 0)), 0) as amt
      from public.money_txns t join public.parties p on p.id = t.party
     where t.kind = 'in' and t.status = 'ok' and p.wedding_key = p_key)
  select b.total, b.paid + case when b.n > 0 then adv.amt else 0 end, b.n from b, adv
$$;
revoke all on function public.client_bills_money(text) from public, anon, authenticated;

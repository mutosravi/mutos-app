-- 046 (24 Nov 2026, Ravi: "Can we put a validity of any link to download flagging its expiry date or deletion date?"). Run after 045.
--   · client_deliveries.expires_on: the last day the family can download (null = no limit). The family page shows
--     "Download before <date>", warns in the last 7 days, and after the date shows "Link expired" with no link
--     (client_after leaves the link out after the date; the studio still sees it).
--   · The app cannot delete the files on Google Drive: Home → Needs you lists expired links still saved, so Muto's deletes
--     the files and then clears the link (or gives more days).
alter table public.client_deliveries add column if not exists expires_on date;

create or replace function public.client_after(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; fam boolean; m jsonb; isopen boolean; tot numeric; pd numeric; today date := (now() at time zone 'Asia/Kolkata')::date;
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
        'has_link', d.link is not null, 'expires_on', d.expires_on, 'expired', d.expires_on is not null and d.expires_on < today,
        'link', case when public.is_desk() or (isopen and (d.expires_on is null or d.expires_on >= today)) then d.link end, 'at', d.updated_at) order by d.sort, d.created_at)
      from public.client_deliveries d where d.wedding_key = l.wedding_key), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'amount', x.amount, 'paid_on', x.paid_on, 'mode', x.mode, 'upi_ref', x.upi_ref,
        'status', x.status, 'why', x.why, 'at', x.at) order by x.at desc)
      from public.client_pay_claims x where x.wedding_key = l.wedding_key), '[]'::jsonb));
end $$;
revoke all on function public.client_after(uuid) from public, anon;
grant execute on function public.client_after(uuid) to authenticated;

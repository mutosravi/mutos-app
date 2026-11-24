-- 044 (24 Nov 2026, Ravi: "Remove editing events option from client's login when event has already passed. They now see their
-- delivery status, payment status, their invoice, calling muto's for changes, requesting services, etc."). Run after 043.
--   · client_bills(token): the family's own bills from the Sales desk (number, date, total, paid, the share link to open it) and
--     Muto's phone (Sales settings) for "Call Muto's" — for the family's Gmails and the studio's preview only.
--   · client_requests: "Request a service" from the family page (extra album, more photos, another shoot …). The family adds one
--     through client_request(token, what, note) (at most 5 open at a time); admin / manager mark it done or answer it with
--     client_request_set(id, status, reply). Nothing else can write the table; the family reads its own through client_bills.

create table if not exists public.client_requests (
  id          uuid primary key default gen_random_uuid(),
  wedding_key text not null check (length(wedding_key) between 1 and 200),
  what        text not null check (length(what) between 1 and 80),
  note        text check (length(note) <= 500),
  status      text not null default 'new' check (status in ('new', 'seen', 'done', 'declined')),
  reply       text check (length(reply) <= 300),
  by_email    text not null,
  at          timestamptz not null default now(),
  decided_by  text,
  decided_at  timestamptz
);
create index if not exists client_requests_w on public.client_requests (wedding_key, at desc);
create index if not exists client_requests_new on public.client_requests (status) where status = 'new';
alter table public.client_requests enable row level security;
drop policy if exists creq_read on public.client_requests;
create policy creq_read on public.client_requests for select to authenticated using (public.is_staff());
revoke all on public.client_requests from anon, authenticated;
grant select on public.client_requests to authenticated;

-- the family's bills and requests, and how to reach Muto's
create or replace function public.client_bills(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; s jsonb := '{}'::jsonb; bills jsonb := '[]'::jsonb;
begin
  select * into l from public.client_links where token = p_token and active;
  if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not ((public.my_email() <> '' and public.my_email() = any(l.emails)) or public.is_desk()) then
    return jsonb_build_object('error', 'Only the family''s registered Gmail can see this.'); end if;
  if to_regclass('public.sales_settings') is not null then
    select coalesce(data, '{}'::jsonb) into s from public.sales_settings where id = 1;
    select coalesce(jsonb_agg(jsonb_build_object('number', d.number, 'kind', d.kind, 'date', d.doc_date, 'total', d.total, 'paid', d.paid, 'token', d.token)
             order by d.doc_date, d.created_at), '[]'::jsonb) into bills
      from public.sales_docs d left join public.parties p on p.id = d.party
     where d.kind in ('invoice', 'gst_invoice') and d.status <> 'cancelled' and coalesce(nullif(d.wedding_key, ''), p.wedding_key) = l.wedding_key;
  end if;
  return jsonb_build_object('studio', coalesce(nullif(s ->> 'name', ''), 'Muto''s'), 'phone', nullif(regexp_replace(coalesce(s ->> 'phone', ''), '[^0-9+]', '', 'g'), ''),
    'bills', coalesce(bills, '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'what', r.what, 'note', r.note, 'status', r.status, 'reply', r.reply, 'at', r.at) order by r.at desc)
      from public.client_requests r where r.wedding_key = l.wedding_key), '[]'::jsonb));
end $$;
revoke all on function public.client_bills(uuid) from public, anon;
grant execute on function public.client_bills(uuid) to authenticated;

-- the family asks for something more
create or replace function public.client_request(p_token uuid, p_what text, p_note text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare l public.client_links; n int; id uuid;
begin
  select * into l from public.client_links where token = p_token and active;
  if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not (public.my_email() <> '' and public.my_email() = any(l.emails)) then return jsonb_build_object('error', 'Only the family''s registered Gmail can ask for a service.'); end if;
  if length(trim(coalesce(p_what, ''))) < 2 then return jsonb_build_object('error', 'Pick what you would like.'); end if;
  select count(*) into n from public.client_requests where wedding_key = l.wedding_key and status in ('new', 'seen');
  if n >= 5 then return jsonb_build_object('error', 'Muto''s is still looking at your earlier requests. Please wait or call us.'); end if;
  insert into public.client_requests (wedding_key, what, note, by_email)
    values (l.wedding_key, left(trim(p_what), 80), nullif(left(trim(coalesce(p_note, '')), 500), ''), public.my_email())
    returning client_requests.id into id;
  return jsonb_build_object('ok', true, 'id', id);
end $$;
revoke all on function public.client_request(uuid, text, text) from public, anon;
grant execute on function public.client_request(uuid, text, text) to authenticated;

-- admin / manager: seen / done / declined, with an answer the family sees
create or replace function public.client_request_set(p_id uuid, p_status text, p_reply text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare r public.client_requests;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can answer a request.'); end if;
  if p_status not in ('seen', 'done', 'declined') then return jsonb_build_object('error', 'Pick seen, done or declined.'); end if;
  if p_status = 'declined' and length(trim(coalesce(p_reply, ''))) < 3 then return jsonb_build_object('error', 'Write a short answer for the family.'); end if;
  update public.client_requests set status = p_status, reply = coalesce(nullif(left(trim(coalesce(p_reply, '')), 300), ''), reply),
         decided_by = public.my_email(), decided_at = now() where id = p_id returning * into r;
  if r.id is null then return jsonb_build_object('error', 'Unknown request.'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.client_request_set(uuid, text, text) from public, anon;
grant execute on function public.client_request_set(uuid, text, text) to authenticated;

-- Muto's app · follow-up to 008/009 (6 Nov 2026, Ravi's answers). Run once, after 010.
-- 1. A late payment never locks the family's details any more: they see a reminder only.
--    (lock_on now means "hold deliveries while late", for later; default off.)
-- 2. Kuldeep looks after the office drives: he is the first drive keeper ("Data & drives" on People).
alter table public.bookings alter column lock_on set default false;
update public.bookings set lock_on = false where lock_on;

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
    'hold_deliveries', b.lock_on and late - paid > 0, 'overdue', greatest(late - paid, 0));
end $$;

create or replace function public.client_save(p_token uuid, p_data jsonb, p_submit boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare l public.client_links;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not (public.my_email() <> '' and public.my_email() = any(l.emails)) then return jsonb_build_object('error', 'Only the family''s registered Gmail can fill this in.'); end if;
  -- room for small photos of the family's important people (each photo is shrunk on the phone first)
  if p_data is null or jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 1500000 then return jsonb_build_object('error', 'Too much to save. Remove a few photos or shorten the notes.'); end if;
  insert into public.client_itinerary as c (wedding_key, data, submitted_at, updated_at)
  values (l.wedding_key, p_data, case when p_submit then now() end, now())
  on conflict (wedding_key) do update set data = excluded.data, updated_at = now(),
    submitted_at = case when p_submit then now() else c.submitted_at end;
  return jsonb_build_object('ok', true, 'saved_at', now());
end $$;

update public.people set skills = array_append(skills, 'data') where lower(name) = 'kuldeep' and not ('data' = any(skills));

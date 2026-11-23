-- 039 (23 Nov 2026, Ravi: team members update their own details → "yes, go ahead"). Run after 038.
-- A team member changes their OWN phone number from the app (My Profile). It applies at once:
--   · people.phone (when they are on People)
--   · every board record of that person (docs shooters / assistants): the ids in people.crew_keys, the board name of their login
--     (members.person_key) and any other record with the same name, so the crew pages, the families' "Your team" card (038) and
--     the board all show the new number after the next sync
-- Every change is written to phone_changes; the admin / manager see unseen ones under Home → Needs you and mark them seen.
-- Name, Gmail, title, skills and rates stay with the admin / manager.

create table if not exists public.phone_changes (
  id          bigserial primary key,
  person      uuid,
  person_key  text,
  name        text not null,
  old_phone   text,
  new_phone   text not null,
  by_email    text not null,
  at          timestamptz not null default now(),
  seen_at     timestamptz,
  seen_by     text
);
alter table public.phone_changes enable row level security;
drop policy if exists phone_changes_read on public.phone_changes;
create policy phone_changes_read on public.phone_changes for select to authenticated using (public.is_staff());
revoke all on public.phone_changes from anon, authenticated;
grant select on public.phone_changes to authenticated;

-- the board records that belong to the signed-in person
create or replace function public.my_board_records() returns setof public.docs
  language sql stable security definer set search_path = public as $$
  with me as (
    select p.crew_keys, p.name as pname, m.person_key
      from (select 1) x
      left join public.people p on p.email = public.my_email() and public.my_email() <> '' and p.active
      left join public.members m on m.email = public.my_email() and public.my_email() <> ''
  ), names as (
    select lower(trim(d.data ->> 'name')) n from public.docs d, me
     where d.collection in ('shooters', 'assistants') and d.id = any(coalesce(me.crew_keys, '{}'))
    union select me.person_key from me where me.person_key is not null
  )
  select d.* from public.docs d
   where d.collection in ('shooters', 'assistants')
     and (d.id = any(coalesce((select crew_keys from me), '{}')) or lower(trim(d.data ->> 'name')) in (select n from names where n is not null and n <> ''))
$$;
revoke all on function public.my_board_records() from public, anon, authenticated;

-- my number as the studio has it now
create or replace function public.my_phone() returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare p public.people; ph text;
begin
  if public.my_email() = '' then return jsonb_build_object('error', 'Sign in first.'); end if;
  select * into p from public.people where email = public.my_email() and active;
  ph := nullif(p.phone, '');
  if ph is null then select nullif(d.data ->> 'phone', '') into ph from public.my_board_records() d where coalesce(d.data ->> 'phone', '') <> '' limit 1; end if;
  return jsonb_build_object('phone', ph, 'can', p.id is not null or exists (select 1 from public.my_board_records()));
end $$;
revoke all on function public.my_phone() from public, anon;
grant execute on function public.my_phone() to authenticated;

create or replace function public.my_phone_set(p_phone text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare p public.people; ph text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'); digits text; old text; who text; pk text; n int := 0; recent int;
begin
  if public.my_email() = '' then return jsonb_build_object('error', 'Sign in first.'); end if;
  digits := regexp_replace(ph, '\D', '', 'g');
  if length(digits) = 12 and digits like '91%' then digits := right(digits, 10); end if;
  if length(digits) <> 10 or digits !~ '^[6-9]' then return jsonb_build_object('error', 'Type your 10-digit mobile number.'); end if;
  select count(*) into recent from public.phone_changes where by_email = public.my_email() and at > now() - interval '1 day';
  if recent >= 5 then return jsonb_build_object('error', 'Too many changes today. Please ask Muto''s.'); end if;
  select * into p from public.people where email = public.my_email() and active;
  select person_key into pk from public.members where email = public.my_email();
  if p.id is null and not exists (select 1 from public.my_board_records()) then
    return jsonb_build_object('error', 'You are not on the studio''s team list yet. Please ask Muto''s.'); end if;
  old := nullif(p.phone, '');
  if old is null then select nullif(d.data ->> 'phone', '') into old from public.my_board_records() d where coalesce(d.data ->> 'phone', '') <> '' limit 1; end if;
  if regexp_replace(coalesce(old, ''), '\D', '', 'g') in (digits, '91' || digits) then return jsonb_build_object('ok', true, 'same', true, 'phone', digits); end if;
  who := coalesce(p.name, (select d.data ->> 'name' from public.my_board_records() d limit 1), public.my_email());
  if p.id is not null then update public.people set phone = digits where id = p.id; end if;
  update public.docs d set data = d.data || jsonb_build_object('phone', digits)
   where (d.collection, d.id) in (select r.collection, r.id from public.my_board_records() r);
  get diagnostics n = row_count;
  insert into public.phone_changes (person, person_key, name, old_phone, new_phone, by_email) values (p.id, pk, left(who, 80), old, digits, public.my_email());
  return jsonb_build_object('ok', true, 'phone', digits, 'board', n);
end $$;
revoke all on function public.my_phone_set(text) from public, anon;
grant execute on function public.my_phone_set(text) to authenticated;

-- the admin / manager: mark changes seen (Needs you)
create or replace function public.phone_changes_seen(p_ids bigint[]) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager.'); end if;
  update public.phone_changes set seen_at = now(), seen_by = public.my_email() where id = any(p_ids) and seen_at is null;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.phone_changes_seen(bigint[]) from public, anon;
grant execute on function public.phone_changes_seen(bigint[]) to authenticated;

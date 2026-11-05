-- Muto's app · clients can also sign in with their phone number (code on WhatsApp). Run after 005_client_login.sql.
-- Each wedding lists the family's phone numbers next to its Gmails. A signed-in phone on that list works exactly like a listed Gmail.
-- The code itself is sent by the Worker (/api/sms-hook, Supabase "Send SMS" hook), and only to numbers on a wedding's list.

alter table public.client_links add column if not exists phones text[] not null default '{}';

-- one way to write a number everywhere: digits only with the country code (98765 43210 → 919876543210)
create or replace function public.norm_phone(p text) returns text language sql immutable as $$
  select case when length(d) = 10 then '91' || d
              when length(d) = 11 and left(d, 1) = '0' then '91' || substr(d, 2)
              else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x $$;

create or replace function public.my_phone() returns text language sql stable as $$
  select public.norm_phone(coalesce(auth.jwt() ->> 'phone', '')) $$;

create or replace function public.clean_phones() returns trigger language plpgsql as $$
begin
  new.phones := coalesce((select array_agg(distinct public.norm_phone(p)) from unnest(new.phones) p where public.norm_phone(p) <> ''), '{}');
  if exists (select 1 from unnest(new.phones) p where p !~ '^\d{11,15}$' or (left(p, 2) = '91' and length(p) <> 12)) then
    raise exception 'Check the phone numbers (10 digits, or with the country code).';
  end if;
  if cardinality(new.phones) > 6 then raise exception 'Up to 6 phone numbers per wedding.'; end if;
  return new;
end $$;
drop trigger if exists client_links_phones on public.client_links;
create trigger client_links_phones before insert or update on public.client_links for each row execute function public.clean_phones();

-- is this wedding's page mine? (signed in with a listed Gmail or a listed phone)
create or replace function public.client_is_mine(l public.client_links) returns boolean language sql stable as $$
  select (public.my_email() <> '' and public.my_email() = any(l.emails))
      or (public.my_phone() <> '' and public.my_phone() = any(l.phones)) $$;

create or replace function public.client_list() returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('token', token, 'title', title) order by created_at), '[]'::jsonb)
  from public.client_links l where active and public.client_is_mine(l) $$;

create or replace function public.client_get(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; f jsonb; i public.client_itinerary; who text;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not (public.client_is_mine(l) or public.is_staff()) then
    who := coalesce(nullif(public.my_email(), ''), nullif('+' || public.my_phone(), '+'), 'not signed in');
    return jsonb_build_object('error', 'This sign-in (' || who || ') is not on Muto''s list for this wedding.', 'not_listed', true);
  end if;
  select data into f from public.client_feed where wedding_key = l.wedding_key;
  select * into i from public.client_itinerary where wedding_key = l.wedding_key;
  return jsonb_build_object('title', l.title, 'functions', coalesce(f -> 'functions', '[]'::jsonb), 'answers', coalesce(i.data, '{}'::jsonb), 'submitted_at', i.submitted_at,
    'preview', not public.client_is_mine(l));
end $$;

create or replace function public.client_save(p_token uuid, p_data jsonb, p_submit boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare l public.client_links;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not public.client_is_mine(l) then return jsonb_build_object('error', 'Only the family''s registered Gmail or phone can fill this in.'); end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 60000 then return jsonb_build_object('error', 'Too much text. Please shorten the notes.'); end if;
  insert into public.client_itinerary as c (wedding_key, data, submitted_at, updated_at)
  values (l.wedding_key, p_data, case when p_submit then now() end, now())
  on conflict (wedding_key) do update set data = excluded.data, updated_at = now(),
    submitted_at = case when p_submit then now() else c.submitted_at end;
  return jsonb_build_object('ok', true, 'saved_at', now());
end $$;

revoke all on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean), public.client_list(), public.client_is_mine(public.client_links) from public, anon;
grant execute on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean), public.client_list(), public.client_is_mine(public.client_links) to authenticated;

-- existing weddings: the booking phone can sign in too (Ravi can remove it in Clients)
update public.client_links set phones = array[phone] where phone is not null and public.norm_phone(phone) ~ '^91\d{10}$' and cardinality(phones) = 0;

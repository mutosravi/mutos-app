-- Muto's app · clients sign in with Gmail (decided 6 Nov 2026). Run after 004_studio.sql.
-- Each wedding's link now lists the family's Gmails; only a signed-in Gmail on that list can open or fill it.
-- The owner and managers can open any wedding's page to preview it (but not fill it in).

alter table public.client_links add column if not exists emails text[] not null default '{}';

create or replace function public.lower_emails() returns trigger language plpgsql as $$
begin
  new.emails := coalesce((select array_agg(distinct lower(trim(e))) from unnest(new.emails) e where trim(e) <> ''), '{}');
  if cardinality(new.emails) > 6 then raise exception 'Up to 6 Gmails per wedding.'; end if;
  return new;
end $$;
drop trigger if exists client_links_emails on public.client_links;
create trigger client_links_emails before insert or update on public.client_links for each row execute function public.lower_emails();

-- weddings the signed-in Gmail may open
create or replace function public.client_list() returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('token', token, 'title', title) order by created_at), '[]'::jsonb)
  from public.client_links where active and public.my_email() <> '' and public.my_email() = any(emails) $$;

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
    'preview', not (public.my_email() = any(l.emails)));
end $$;

create or replace function public.client_save(p_token uuid, p_data jsonb, p_submit boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare l public.client_links;
begin
  select * into l from public.client_links where token = p_token and active;
  if not found then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  if not (public.my_email() <> '' and public.my_email() = any(l.emails)) then return jsonb_build_object('error', 'Only the family''s registered Gmail can fill this in.'); end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 60000 then return jsonb_build_object('error', 'Too much text. Please shorten the notes.'); end if;
  insert into public.client_itinerary as c (wedding_key, data, submitted_at, updated_at)
  values (l.wedding_key, p_data, case when p_submit then now() end, now())
  on conflict (wedding_key) do update set data = excluded.data, updated_at = now(),
    submitted_at = case when p_submit then now() else c.submitted_at end;
  return jsonb_build_object('ok', true, 'saved_at', now());
end $$;

-- nothing for visitors who are not signed in
revoke all on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean), public.client_list() from public, anon;
grant execute on function public.client_get(uuid), public.client_save(uuid, jsonb, boolean), public.client_list() to authenticated;

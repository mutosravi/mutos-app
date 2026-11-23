-- 038 (23 Nov 2026, Ravi: "Show team names with their numbers to contact prior 1 day"). Run after 037.
-- The studio's board sends each function's team (name, role, phone) to client_feed.data.team (clients.js), next to the
-- function list. client_get never returns it. The family gets it only through client_team(), and only for functions dated
-- tomorrow or today (India time): from the day before, until the function day ends. The studio (admin / manager / supervisor)
-- sees the team of every function from today on in the preview, so they can check what the family will get.
create or replace function public.client_team(p_token uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare l public.client_links; f jsonb; fam boolean; desk boolean; today date := (now() at time zone 'Asia/Kolkata')::date; out jsonb := '[]'::jsonb;
begin
  select * into l from public.client_links where token = p_token and active;
  if l.wedding_key is null then return jsonb_build_object('error', 'This page is not active. Please ask Muto''s.'); end if;
  fam := public.my_email() <> '' and public.my_email() = any(l.emails); desk := public.is_desk();
  if not (fam or desk) then return jsonb_build_object('error', 'Only the family''s registered Gmail can see this.'); end if;
  select data into f from public.client_feed where wedding_key = l.wedding_key;
  if f is null or jsonb_typeof(f -> 'team') <> 'object' then return jsonb_build_object('functions', out, 'opens', 'the day before'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', fn ->> 'id', 'name', fn ->> 'name', 'date', fn ->> 'date', 'slot', fn ->> 'slot',
           'team', (select coalesce(jsonb_agg(jsonb_build_object('name', left(t ->> 'name', 60), 'role', left(coalesce(t ->> 'role', ''), 60),
                                                                'phone', left(regexp_replace(coalesce(t ->> 'phone', ''), '[^0-9+ ]', '', 'g'), 20))), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(f -> 'team' -> (fn ->> 'id'), '[]'::jsonb)) t where coalesce(t ->> 'name', '') <> ''))
         order by fn ->> 'date', fn ->> 'slot'), '[]'::jsonb) into out
    from jsonb_array_elements(coalesce(f -> 'functions', '[]'::jsonb)) fn
   where (fn ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
     and (fn ->> 'date')::date >= today and (desk or (fn ->> 'date')::date <= today + 1);
  return jsonb_build_object('functions', out, 'preview', desk and not fam);
end $$;
revoke all on function public.client_team(uuid) from public, anon;
grant execute on function public.client_team(uuid) to authenticated;

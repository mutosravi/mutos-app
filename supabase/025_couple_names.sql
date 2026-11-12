-- 025: the couple's names (12 Nov 2026, Ravi: "Client also fill couple name in the form"). Run after 024.
-- The family's form keeps them in client_itinerary.data.couple = { bride, groom } (no table change). The crew on a shoot of that
-- wedding now get them too, next to the important people and who to call.
create or replace function public.crew_vip(p_event text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare k text; d jsonb;
begin
  if not (public.is_staff() or exists (select 1 from public.crew_feed f, jsonb_array_elements(coalesce(f.data -> 'shoots', '[]'::jsonb)) s
                                       where f.person_key = public.my_person_key() and s ->> 'id' = p_event)) then
    return jsonb_build_object('error', 'Only the crew on this shoot can see the family''s details.');
  end if;
  select cf.wedding_key into k from public.client_feed cf, jsonb_array_elements(coalesce(cf.data -> 'functions', '[]'::jsonb)) fn where fn ->> 'id' = p_event limit 1;
  if k is null then return jsonb_build_object('vip', '[]'::jsonb, 'contacts', '[]'::jsonb, 'couple', '{}'::jsonb); end if;
  select data into d from public.client_itinerary where wedding_key = k;
  return jsonb_build_object('vip', coalesce(d -> 'vip', '[]'::jsonb),
    'contacts', coalesce((select jsonb_agg(c) from jsonb_array_elements(coalesce(d -> 'contacts', '[]'::jsonb)) c where coalesce(c ->> 'fn', '') in ('', p_event)), '[]'::jsonb),
    'couple', jsonb_build_object('bride', left(coalesce(d #>> '{couple,bride}', ''), 80), 'groom', left(coalesce(d #>> '{couple,groom}', ''), 80)));
end $$;
revoke all on function public.crew_vip(text) from public, anon;
grant execute on function public.crew_vip(text) to authenticated;

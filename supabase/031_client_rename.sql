-- 031 (20 Nov 2026, Ravi: "Add rename client button"). Run after 030.
-- A client is the board's shoots with the same client (wedding) name, and the rest of the studio is linked to that name through
-- wedding_key ("w:<name in lower case>"). The board renames the client on every shoot; this moves everything that hangs on the
-- old key to the new one in one go, so nothing is left behind under the old name:
--   family login + form answers (client_links, client_feed, client_itinerary), package & payments (bookings → booking_payments
--   follow by the foreign key), Work desk jobs, drive data, family photos, the log of form answers put on the board.
-- Admin or manager only. If the new name already belongs to another client with its own family login, form or package, it
-- stops and says so (two families' answers or payments are never merged by a rename). One line per shoot in the client's History.

create or replace function public.client_rename(p_old text, p_new text, p_title text, p_events text[]) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare o text := left(trim(coalesce(p_old, '')), 200); n text := left(trim(coalesce(p_new, '')), 200); t text := left(trim(coalesce(p_title, '')), 120);
        moved jsonb := '{}'::jsonb; c int; e text;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can rename a client.'); end if;
  if o = '' or n = '' or t = '' then return jsonb_build_object('error', 'Type the new name.'); end if;
  if o = n then return jsonb_build_object('ok', true, 'moved', moved); end if;
  if exists (select 1 from public.client_links where wedding_key = n) and exists (select 1 from public.client_links where wedding_key = o) then
    return jsonb_build_object('error', '"' || t || '" already has its own family login. Pick another name, or remove one of the two family logins first.'); end if;
  if exists (select 1 from public.client_itinerary where wedding_key = n) and exists (select 1 from public.client_itinerary where wedding_key = o) then
    return jsonb_build_object('error', '"' || t || '" already has a family form filled in. Pick another name.'); end if;
  if exists (select 1 from public.bookings where wedding_key = n) and exists (select 1 from public.bookings where wedding_key = o) then
    return jsonb_build_object('error', '"' || t || '" already has its own package and payments. Pick another name.'); end if;

  perform set_config('mutos.quiet', '1', true);
  update public.client_links set wedding_key = n, title = t where wedding_key = o; get diagnostics c = row_count; moved := moved || jsonb_build_object('family_login', c);
  update public.client_links set title = t where wedding_key = n;
  delete from public.client_feed where wedding_key = n and exists (select 1 from public.client_feed where wedding_key = o);   -- the board sends it again
  update public.client_feed set wedding_key = n where wedding_key = o;
  update public.client_itinerary set wedding_key = n where wedding_key = o; get diagnostics c = row_count; moved := moved || jsonb_build_object('form', c);
  update public.bookings set wedding_key = n where wedding_key = o; get diagnostics c = row_count; moved := moved || jsonb_build_object('package', c);
  update public.work_jobs set wedding_key = n, wedding_title = t where wedding_key = o; get diagnostics c = row_count; moved := moved || jsonb_build_object('jobs', c);
  update public.drive_items set wedding_key = n where wedding_key = o; get diagnostics c = row_count; moved := moved || jsonb_build_object('drive_lines', c);
  update public.uploads set wedding_key = n where wedding_key = o; get diagnostics c = row_count; moved := moved || jsonb_build_object('photos', c);
  update public.client_apply_log set wedding_key = n where wedding_key = o;
  perform set_config('mutos.quiet', '', true);

  foreach e in array coalesce(p_events, '{}') loop
    if length(e) between 1 and 100 then
      insert into public.client_log (event_id, wedding, kind, what) values (e, t, 'rename', left('Client renamed to ' || t || ' by ' || public.me_label(), 600));
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'moved', moved);
end $$;
revoke all on function public.client_rename(text, text, text, text[]) from public, anon;
grant execute on function public.client_rename(text, text, text, text[]) to authenticated;

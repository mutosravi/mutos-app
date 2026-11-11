-- Muto's app · Phone notices for memory cards (11 Nov 2026, Ravi: "notification for both giving and receiving"). Run once, after 014_cards.sql.
--
-- Until now only crew could turn on phone notices (push_subs.person_key = their board key). The owner, managers, the
-- supervisor and office people now sign up too, under "email:<their gmail>". The server (/api/notify-card) sends:
--   • cards given  → the receiver's phones (the owner and managers for a return to the office)
--   • cards accepted or "not received" → the giver's phones

create or replace function public.my_push_key() returns text
  language sql stable as $$ select coalesce(public.my_person_key(), 'email:' || public.my_email()) $$;

drop policy if exists push_select on public.push_subs;
create policy push_select on public.push_subs for select to authenticated
  using (person_key = public.my_person_key() or person_key = 'email:' || public.my_email());
drop policy if exists push_insert on public.push_subs;
create policy push_insert on public.push_subs for insert to authenticated
  with check (public.my_role() is not null and person_key = public.my_push_key());   -- logins only (not families)
drop policy if exists push_update on public.push_subs;
create policy push_update on public.push_subs for update to authenticated
  using (person_key = public.my_person_key() or person_key = 'email:' || public.my_email()) with check (person_key = public.my_push_key());
drop policy if exists push_delete on public.push_subs;
create policy push_delete on public.push_subs for delete to authenticated
  using (person_key = public.my_person_key() or person_key = 'email:' || public.my_email());

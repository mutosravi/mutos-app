-- Muto's app · Drive keepers only hand over and receive (11 Nov 2026, Ravi: "They should not edit drive details in any way.
-- Just handover and receive."). Run once, after 015_card_notify.sql.
--
-- A drive keeper (People → skill "Data copy") can still:
--   • give office drives to the team, and accept drives returned to the office (drive_give / drive_answer, unchanged)
-- but can no longer:
--   • add drives, change a drive's details, status, free space or "cleaned" date
--   • add, rename, move, copy or remove what is listed on a drive (unless that drive is with him, like anyone else)
-- Drive details are now changed only by the owner and the manager. Whoever has a drive still lists the data on it.

-- data on a drive: the studio, or whoever has the drive (the keeper no longer by default)
create or replace function public.can_drive(d uuid) returns boolean language sql stable security definer set search_path = public as $$
  select public.is_staff() or exists (select 1 from public.drives where id = d and holder is not null and holder = public.my_person()) $$;

drop policy if exists drives_insert on public.drives;
create policy drives_insert on public.drives for insert to authenticated with check (public.is_staff());
drop policy if exists drives_update on public.drives;
create policy drives_update on public.drives for update to authenticated using (public.is_staff()) with check (public.is_staff());

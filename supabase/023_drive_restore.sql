-- 023: bring back a drive line removed by mistake (12 Nov 2026, Ravi: "Mistakenly deleted a data copy entry from drive").
-- Drive lines are never deleted, only marked removed (removed_at / removed_why). Until now the only way back was to add the line
-- again, which loses its history and its link to the card copy it came from. drive_item_restore() puts the same line back:
-- admin (owner) or manager only, a reason is required, logged on the drive. A line that was MOVED to another drive is not
-- restored (the data is on the other drive; restoring would list it twice). Run after 022.

-- the drive-line rules from 008, with one exception: drive_item_restore() may clear removed_at (it sets mutos.restore)
create or replace function public.drive_items_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if old.removed_at is not null and new.removed_at is null and coalesce(current_setting('mutos.restore', true), '') <> '1' then raise exception 'Removed data stays in the history; add it again instead.'; end if;
    if row(new.drive, new.from_item, new.added_by, new.added_at) is distinct from row(old.drive, old.from_item, old.added_by, old.added_at) then raise exception 'Use Move to put data on another drive.'; end if;
  else
    new.added_by := public.my_email(); new.added_at := now(); new.removed_at := null; new.removed_why := null; new.moved_to := null;
  end if;
  new.title := trim(new.title);
  if coalesce(current_setting('mutos.quiet', true), '') <> '1' then
    if tg_op = 'INSERT' then perform public.drive_note(new.drive, 'Data added: ' || new.title || ' (' || new.what || coalesce(', ' || new.size_label, '') || ')');
    elsif new.removed_at is not null and old.removed_at is null then
      new.removed_why := coalesce(new.removed_why, 'cleaned');
      perform public.drive_note(new.drive, 'Data removed (' || new.removed_why || '): ' || new.title || ' (' || new.what || ')');
    elsif row(new.title, new.what, new.size_label, new.note) is distinct from row(old.title, old.what, old.size_label, old.note) then
      perform public.drive_note(new.drive, 'Data renamed: ' || old.title || ' → ' || new.title);
    end if;
  end if;
  return new;
end $$;

create or replace function public.drive_item_restore(p_item uuid, p_why text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare it public.drive_items; dn text;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can bring back removed data.'); end if;
  select * into it from public.drive_items where id = p_item;
  if not found then return jsonb_build_object('error', 'Unknown line.'); end if;
  if it.removed_at is null then return jsonb_build_object('error', 'This line is already on the drive.'); end if;
  if it.moved_to is not null then
    select d.name into dn from public.drive_items x join public.drives d on d.id = x.drive where x.id = it.moved_to;
    return jsonb_build_object('error', 'This was moved to ' || coalesce(dn, 'another drive') || ', so it is listed there. Nothing to bring back.');
  end if;
  if coalesce(trim(p_why), '') = '' then return jsonb_build_object('error', 'Write why (e.g. "removed by mistake").'); end if;
  perform set_config('mutos.restore', '1', true); perform set_config('mutos.quiet', '1', true);
  update public.drive_items set removed_at = null, removed_why = null where id = it.id;
  perform set_config('mutos.restore', '', true); perform set_config('mutos.quiet', '', true);
  perform public.drive_note(it.drive, 'Data brought back: ' || it.title || ' (' || it.what || ') by ' || public.me_label() || ' (' || left(trim(p_why), 200) || '; it was removed '
    || to_char(it.removed_at at time zone 'Asia/Kolkata', 'DD Mon HH12:MI am') || coalesce(' as "' || it.removed_why || '"', '') || ')');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.drive_item_restore(uuid, text) from public, anon;
grant execute on function public.drive_item_restore(uuid, text) to authenticated;

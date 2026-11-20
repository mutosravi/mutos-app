-- 034 (20 Nov 2026, Ravi: "How to move a folder in another drive?" → "Yes" to moving whole folders at once). Run after 033.
-- drive_folders_to_drive(drive, moves [{id, path}], to, copy): every ticked line (folders with their subfolders, worked out by the
-- page as in 030) goes to the other drive in its new folder, in one go: all or nothing, one line in each drive's history.
--   · move (copy = false): like drive_move_item for each line (new line on the other drive, the old one marked "moved"), for the
--     studio or whoever holds either drive. Card copies still count (a moved line lives on).
--   · copy (copy = true): a backup on the other drive, like drive_backup_item: admin / manager only; lines already on that drive
--     are skipped; every card whose current-round copy made a line and still has one copy turns copied (backup card copy).

create or replace function public.drive_folders_to_drive(p_drive uuid, p_moves jsonb, p_to uuid, p_copy boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare src public.drives; dst public.drives; m jsonb; it public.drive_items; nid uuid; np text; n int := 0; skipped int := 0;
        cc record; done text[] := '{}'; folders text; total int;
begin
  select * into src from public.drives where id = p_drive; select * into dst from public.drives where id = p_to;
  if src.id is null then return jsonb_build_object('error', 'Unknown drive.'); end if;
  if dst.id is null then return jsonb_build_object('error', 'Pick the drive.'); end if;
  if dst.id = src.id then return jsonb_build_object('error', 'That is the same drive. Use Move to change folders on it.'); end if;
  if dst.status <> 'in_use' then return jsonb_build_object('error', dst.name || ' is marked ' || replace(dst.status, '_', ' ') || '.'); end if;
  if coalesce(p_copy, false) then
    if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can record a copy (backup) on another drive.'); end if;
  elsif not (public.can_drive(src.id) or public.can_drive(dst.id)) then
    return jsonb_build_object('error', 'Only the studio or whoever has the drive can move data.');
  end if;
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 then return jsonb_build_object('error', 'Pick the folders.'); end if;
  total := jsonb_array_length(p_moves);
  if total > 20000 then return jsonb_build_object('error', 'Too many at once.'); end if;
  if (select count(distinct i.id) from jsonb_array_elements(p_moves) x join public.drive_items i on i.id = (x ->> 'id')::uuid
      where i.drive = src.id and i.removed_at is null) <> total then
    return jsonb_build_object('error', 'Some of these are no longer on ' || src.name || '. Open the drive again and retry.'); end if;
  for m in select * from jsonb_array_elements(p_moves) loop
    if public.drive_path(m ->> 'path') is null then return jsonb_build_object('error', 'Every item needs a folder to go to.'); end if;
  end loop;

  begin   -- one block: an error anywhere undoes everything in it
    perform set_config('mutos.quiet', '1', true);
    for m in select * from jsonb_array_elements(p_moves) loop
      select * into it from public.drive_items where id = (m ->> 'id')::uuid;
      np := public.drive_path(m ->> 'path');
      if p_copy and exists (select 1 from public.drive_items x where x.drive = dst.id and x.removed_at is null
                            and (x.from_item = it.id or (it.from_item is not null and (x.id = it.from_item or x.from_item = it.from_item)))) then
        skipped := skipped + 1; continue;
      end if;
      insert into public.drive_items (drive, wedding_key, title, what, size_label, files, path, note, from_item)
        values (dst.id, it.wedding_key, it.title, case when p_copy then 'backup' else it.what end, it.size_label, it.files, np,
                case when p_copy then left('Backup of ' || src.name || coalesce(' · ' || it.note, ''), 300) else it.note end, it.id)
        returning id into nid;
      perform set_config('mutos.quiet', '1', true);
      update public.drive_items set path = np where id = nid;   -- the copy trigger of 029 may have set the old folder
      if not p_copy then
        perform set_config('mutos.quiet', '1', true);
        update public.drive_items set removed_at = now(), removed_why = 'moved', moved_to = nid where id = it.id;
      else
        for cc in select distinct on (k.id) k.id as card, k.code, k.cycle, c0.files from public.card_copies c0 join public.cards k on k.id = c0.card
                  where it.id = any(c0.items) and c0.cycle = k.cycle and k.data = 'single' order by k.id loop
          insert into public.card_copies (card, cycle, backup, drive, drive_name, folder, files, size_label, items, by_email)
            values (cc.card, cc.cycle, true, dst.id, dst.name, left(np, 200), coalesce(nullif(it.files, 0), cc.files), it.size_label, array[nid], public.my_email());
          perform set_config('mutos.quiet', '1', true);   -- triggers on card_copies may have cleared it
          update public.cards set data = 'copied', data_since = null where id = cc.card;
          perform set_config('mutos.quiet', '', true);
          perform public.card_note(cc.card, 'Backup copied to ' || dst.name || ' / ' || np || ' (folder copied from ' || src.name || '). Safe: two copies.');
          perform set_config('mutos.quiet', '1', true);
          done := done || cc.code;
        end loop;
      end if;
      n := n + 1;
    end loop;
    perform set_config('mutos.quiet', '', true);
  exception when others then
    perform set_config('mutos.quiet', '', true);
    return jsonb_build_object('error', 'Nothing was moved: ' || sqlerrm);
  end;

  if n = 0 then return jsonb_build_object('error', 'Everything here is already on ' || dst.name || '.'); end if;
  select string_agg(distinct split_part(coalesce(i.path, i.title), '/', 1), ', ') into folders
    from jsonb_array_elements(p_moves) x join public.drive_items i on i.id = (x ->> 'id')::uuid;
  perform public.drive_note(src.id, left(case when p_copy then 'Copied ' else 'Moved ' end || folders || ' to ' || dst.name, 400) || ' (' || n || ' item' || case when n = 1 then '' else 's' end || ', ' || public.me_label() || ')');
  perform public.drive_note(dst.id, left(folders || ' ' || case when p_copy then 'copied (backup)' else 'moved' end || ' here from ' || src.name, 400) || ' (' || n || ' item' || case when n = 1 then '' else 's' end || ')');
  return jsonb_build_object('ok', true, 'done', n, 'skipped', skipped, 'cards', to_jsonb(done));
end $$;
revoke all on function public.drive_folders_to_drive(uuid, jsonb, uuid, boolean) from public, anon;
grant execute on function public.drive_folders_to_drive(uuid, jsonb, uuid, boolean) to authenticated;

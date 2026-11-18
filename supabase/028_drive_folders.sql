-- 028 (18 Nov 2026, Ravi: "A drive should open like a normal drive in a mac system where I can see folders, number of files and size.
-- I can also backup that folder to other particular drive and it makes changes to other drive and the cards used. Once that folder
-- is backed up from drive itself, the cards status changes to copied and available automatically."). Run after 027.
-- Decided with Ravi: folder view with file counts and sizes typed by the team for now; scanning a drive from the Mac can come later.
--   · drive_items.files: how many files are in the folder (card copies fill it in from the count typed when copying)
--   · drive_backup_item(item, to): the admin or manager records that a folder was backed up to another drive. The backup line is
--     added there (linked to the original), and every card whose footage is in that folder and still has only one copy gets its
--     backup recorded too: it turns green (copied, safe to format) by itself, with a line in the card's history.

alter table public.drive_items add column if not exists files int check (files >= 0);

-- folders made by card copies before this file: take the file count from the copy (when the copy made just this one folder)
update public.drive_items i set files = cc.files
  from public.card_copies cc where i.files is null and cc.items = array[i.id];

create or replace function public.drive_backup_item(p_item uuid, p_to uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare it public.drive_items; src public.drives; dst public.drives; nid uuid; cc record; done text[] := '{}'; n int;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can record a backup.'); end if;
  select * into it from public.drive_items where id = p_item and removed_at is null;
  if not found then return jsonb_build_object('error', 'That folder is no longer on the drive.'); end if;
  select * into src from public.drives where id = it.drive; select * into dst from public.drives where id = p_to;
  if dst.id is null then return jsonb_build_object('error', 'Pick the drive it was backed up to.'); end if;
  if dst.id = src.id then return jsonb_build_object('error', 'A backup must be on a different drive.'); end if;
  if dst.status <> 'in_use' then return jsonb_build_object('error', dst.name || ' is marked ' || replace(dst.status, '_', ' ') || '.'); end if;
  if exists (select 1 from public.drive_items x where x.drive = dst.id and x.removed_at is null and (x.from_item = it.id or (it.from_item is not null and x.id = it.from_item))) then
    return jsonb_build_object('error', it.title || ' is already on ' || dst.name || '.');
  end if;
  perform set_config('mutos.quiet', '1', true);
  insert into public.drive_items (drive, wedding_key, title, what, size_label, files, note, from_item)
    values (dst.id, it.wedding_key, it.title, 'backup', it.size_label, it.files, left('Backup of ' || src.name || coalesce(' · ' || it.note, ''), 300), it.id)
    returning id into nid;
  perform set_config('mutos.quiet', '', true);
  perform public.drive_note(src.id, 'Backed up ' || it.title || ' to ' || dst.name || ' (' || public.me_label() || ')');
  perform public.drive_note(dst.id, it.title || ' backed up here from ' || src.name || coalesce(' · ' || it.files || ' files', '') || coalesce(' · ' || it.size_label, ''));
  -- the cards whose footage is in this folder (this round), still with one copy: backup done → copied
  for cc in select distinct on (k.id) k.id as card, k.code, k.cycle, k.data, c0.files from public.card_copies c0 join public.cards k on k.id = c0.card
            where it.id = any(c0.items) and c0.cycle = k.cycle and k.data = 'single' order by k.id loop
    insert into public.card_copies (card, cycle, backup, drive, drive_name, folder, files, size_label, items, by_email)
      values (cc.card, cc.cycle, true, dst.id, dst.name, left(it.title, 200), coalesce(nullif(it.files, 0), cc.files), it.size_label, array[nid], public.my_email());
    perform set_config('mutos.quiet', '1', true);
    update public.cards set data = 'copied', data_since = null where id = cc.card;
    perform set_config('mutos.quiet', '', true);
    perform public.card_note(cc.card, 'Backup copied to ' || dst.name || ' / ' || it.title || ' (folder backed up from ' || src.name || '). Safe: two copies.');
    done := done || cc.code;
  end loop;
  n := coalesce(array_length(done, 1), 0);
  return jsonb_build_object('ok', true, 'id', nid, 'cards', to_jsonb(done), 'cards_copied', n);
end $$;
revoke all on function public.drive_backup_item(uuid, uuid) from public, anon;
grant execute on function public.drive_backup_item(uuid, uuid) to authenticated;

-- 029 (18 Nov 2026, Ravi: "I can see data card wise in the drive which makes it long list … Folder wise data as it looks on finder
-- would be a better solution. I can everytime give it a folder and subfolder name whenever I copy card somewhere."). Run after 028.
-- Every line of a drive gets the folder it sits in (path "Sharma/Haldi/Candid"). Copying a card already asks for that folder; it is
-- now kept on the drive lines too, so a drive opens as folders → subfolders → what is inside, like Finder. Lines from before keep
-- their place under the client's name until someone gives them a folder.
--   · drive_items.path, filled from the card copy that made the line (now and from here on)
--   · move / copy / backup keep the path
--   · drive_backup_folder(drive, path, to): back up a whole folder (every line in it and its subfolders) in one go;
--     the cards in it with one copy turn copied, as with drive_backup_item (028)

alter table public.drive_items add column if not exists path text check (length(path) <= 200);

-- "/ Sharma // Haldi /" → "Sharma/Haldi"
create or replace function public.drive_path(p text) returns text language sql immutable as $$
  select nullif(left(array_to_string(array(select trim(x) from unnest(string_to_array(coalesce(p, ''), '/')) x where trim(x) <> ''), '/'), 200), '') $$;

-- lines made by a card copy sit in the copy's folder
create or replace function public.card_copies_path_trg() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.drive_path(new.folder) is not null and coalesce(array_length(new.items, 1), 0) > 0 then
    perform set_config('mutos.quiet', '1', true);
    update public.drive_items set path = public.drive_path(new.folder) where id = any(new.items) and path is null;
    perform set_config('mutos.quiet', '', true);
  end if;
  return null;
end $$;
drop trigger if exists card_copies_path_trg on public.card_copies;
create trigger card_copies_path_trg after insert on public.card_copies for each row execute function public.card_copies_path_trg();

-- once: lines from earlier card copies
do $$ begin
  perform set_config('mutos.quiet', '1', true);
  update public.drive_items i set path = public.drive_path(cc.folder)
    from public.card_copies cc where i.id = any(cc.items) and i.path is null and public.drive_path(cc.folder) is not null;
  perform set_config('mutos.quiet', '', true);
end $$;

-- typed lines: tidy the folder the same way
create or replace function public.drive_items_path_trg() returns trigger language plpgsql as $$
begin new.path := public.drive_path(new.path); return new; end $$;
drop trigger if exists drive_items_path_trg on public.drive_items;
create trigger drive_items_path_trg before insert or update of path on public.drive_items for each row execute function public.drive_items_path_trg();

-- move / copy keeps the folder (008, plus path)
create or replace function public.drive_move_item(p_item uuid, p_to_drive uuid, p_copy boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare it public.drive_items; src public.drives; dst public.drives; nid uuid;
begin
  select * into it from public.drive_items where id = p_item and removed_at is null;
  if not found then return jsonb_build_object('error', 'That data is no longer on the drive.'); end if;
  select * into src from public.drives where id = it.drive; select * into dst from public.drives where id = p_to_drive;
  if dst.id is null then return jsonb_build_object('error', 'Pick the drive to move it to.'); end if;
  if dst.id = src.id then return jsonb_build_object('error', 'That is the same drive.'); end if;
  if dst.status <> 'in_use' then return jsonb_build_object('error', dst.name || ' is marked ' || replace(dst.status, '_', ' ') || '.'); end if;
  if not (public.can_drive(src.id) or public.can_drive(dst.id)) then return jsonb_build_object('error', 'Only the studio or whoever has the drive can move data.'); end if;
  perform set_config('mutos.quiet', '1', true);
  insert into public.drive_items (drive, wedding_key, title, what, size_label, files, path, note, from_item) values (dst.id, it.wedding_key, it.title, it.what, it.size_label, it.files, it.path, it.note, it.id) returning id into nid;
  if not p_copy then update public.drive_items set removed_at = now(), removed_why = 'moved', moved_to = nid where id = it.id; end if;
  perform set_config('mutos.quiet', '', true);
  perform public.drive_note(src.id, case when p_copy then 'Copied ' else 'Moved ' end || it.title || ' (' || it.what || ') to ' || dst.name);
  perform public.drive_note(dst.id, it.title || ' (' || it.what || ') ' || case when p_copy then 'copied' else 'moved' end || ' here from ' || src.name);
  return jsonb_build_object('ok', true, 'id', nid);
end $$;

-- backup of one line keeps the folder (028, plus path)
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
  insert into public.drive_items (drive, wedding_key, title, what, size_label, files, path, note, from_item)
    values (dst.id, it.wedding_key, it.title, 'backup', it.size_label, it.files, it.path, left('Backup of ' || src.name || coalesce(' · ' || it.note, ''), 300), it.id)
    returning id into nid;
  perform set_config('mutos.quiet', '', true);
  perform public.drive_note(src.id, 'Backed up ' || it.title || ' to ' || dst.name || ' (' || public.me_label() || ')');
  perform public.drive_note(dst.id, it.title || ' backed up here from ' || src.name || coalesce(' · ' || it.files || ' files', '') || coalesce(' · ' || it.size_label, ''));
  for cc in select distinct on (k.id) k.id as card, k.code, k.cycle, k.data, c0.files from public.card_copies c0 join public.cards k on k.id = c0.card
            where it.id = any(c0.items) and c0.cycle = k.cycle and k.data = 'single' order by k.id loop
    insert into public.card_copies (card, cycle, backup, drive, drive_name, folder, files, size_label, items, by_email)
      values (cc.card, cc.cycle, true, dst.id, dst.name, left(coalesce(it.path, it.title), 200), coalesce(nullif(it.files, 0), cc.files), it.size_label, array[nid], public.my_email());
    perform set_config('mutos.quiet', '1', true);
    update public.cards set data = 'copied', data_since = null where id = cc.card;
    perform set_config('mutos.quiet', '', true);
    perform public.card_note(cc.card, 'Backup copied to ' || dst.name || ' / ' || coalesce(it.path, it.title) || ' (folder backed up from ' || src.name || '). Safe: two copies.');
    done := done || cc.code;
  end loop;
  n := coalesce(array_length(done, 1), 0);
  return jsonb_build_object('ok', true, 'id', nid, 'cards', to_jsonb(done), 'cards_copied', n);
end $$;

-- back up a whole folder (and its subfolders) in one go
create or replace function public.drive_backup_folder(p_drive uuid, p_path text, p_to uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare p text := public.drive_path(p_path); it record; r jsonb; n int := 0; skipped int := 0; cards jsonb := '[]'::jsonb;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can record a backup.'); end if;
  if p is null then return jsonb_build_object('error', 'Open a folder first.'); end if;
  for it in select id from public.drive_items where drive = p_drive and removed_at is null and (path = p or path like p || '/%') order by path, title loop
    r := public.drive_backup_item(it.id, p_to);
    if r ? 'error' then
      if r ->> 'error' like '%is already on%' then skipped := skipped + 1; else return r; end if;
    else n := n + 1; cards := cards || coalesce(r -> 'cards', '[]'::jsonb); end if;
  end loop;
  if n = 0 and skipped = 0 then return jsonb_build_object('error', 'Nothing listed in ' || p || '.'); end if;
  return jsonb_build_object('ok', true, 'lines', n, 'skipped', skipped, 'cards', cards, 'cards_copied', jsonb_array_length(cards));
end $$;
revoke all on function public.drive_backup_folder(uuid, text, uuid) from public, anon;
grant execute on function public.drive_backup_folder(uuid, text, uuid) to authenticated;

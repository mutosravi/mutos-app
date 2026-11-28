-- 048 · Cards with photos AND videos (28 Nov 2026, Ravi: "Some cards have both photos and videos in it. While marking them
-- copied I would need to mention numbers of both photos and videos and sizes as well. Turn this feature on in only 'both' selected cards.")
-- Run after 047 (works on any database that has 014). Safe to run again.
-- card_copy gets an optional 7th argument p_split = {"photos": n, "videos": n, "photo_size": "64 GB", "video_size": "210 GB"}:
-- files = photos + videos, the four numbers are kept on the copy, and the drive line's note and the card's history say them.
-- Calls without it work exactly as before.

alter table public.card_copies add column if not exists photos int check (photos is null or photos >= 0);
alter table public.card_copies add column if not exists videos int check (videos is null or videos >= 0);
alter table public.card_copies add column if not exists photo_size text check (photo_size is null or length(photo_size) <= 20);
alter table public.card_copies add column if not exists video_size text check (video_size is null or length(video_size) <= 20);

drop function if exists public.card_copy(uuid, uuid, text, int, text, jsonb);
create or replace function public.card_copy(p_card uuid, p_drive uuid, p_folder text, p_files int, p_size text, p_items jsonb, p_split jsonb default null) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare k public.cards; d public.drives; first_drive uuid; is_bk boolean; it jsonb; ids uuid[] := '{}'; nid uuid; label text;
  ph int; vd int; phs text; vds text; split_txt text;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can mark a card copied.'); end if;
  select * into k from public.cards where id = p_card; if not found then return jsonb_build_object('error', 'Unknown card.'); end if;
  if k.data not in ('hold', 'single') then return jsonb_build_object('error', k.code || ' has nothing waiting to be copied.'); end if;
  select * into d from public.drives where id = p_drive;
  if d.id is null then return jsonb_build_object('error', 'Pick the drive it was copied to.'); end if;
  if d.status <> 'in_use' then return jsonb_build_object('error', d.name || ' is marked ' || replace(d.status, '_', ' ') || '.'); end if;
  if p_split is not null and jsonb_typeof(p_split) = 'object' then
    begin ph := nullif(p_split ->> 'photos', '')::int; vd := nullif(p_split ->> 'videos', '')::int;
    exception when others then return jsonb_build_object('error', 'Photos and videos must be numbers.'); end;
    if coalesce(ph, 0) < 1 or coalesce(vd, 0) < 1 then return jsonb_build_object('error', 'Write how many photos AND how many videos were copied (count them on the drive).'); end if;
    phs := nullif(left(trim(coalesce(p_split ->> 'photo_size', '')), 20), ''); vds := nullif(left(trim(coalesce(p_split ->> 'video_size', '')), 20), '');
    p_files := ph + vd;
    split_txt := ph || ' photos' || coalesce(' (' || phs || ')', '') || ' + ' || vd || ' videos' || coalesce(' (' || vds || ')', '');
  end if;
  if coalesce(p_files, 0) < 1 then return jsonb_build_object('error', 'Write how many files were copied (count them on the drive).'); end if;
  if coalesce(trim(p_folder), '') = '' then return jsonb_build_object('error', 'Write the folder on the drive.'); end if;
  is_bk := k.data = 'single';
  if is_bk then
    select drive into first_drive from public.card_copies where card = k.id and cycle = k.cycle and not card_copies.backup order by at desc limit 1;
    if first_drive = d.id then return jsonb_build_object('error', 'The backup must be on a different drive from the first copy.'); end if;
  end if;
  label := 'from card ' || k.code || ' · ' || trim(p_folder) || ' · ' || coalesce(split_txt, p_files || ' files');
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then p_items := jsonb_build_array(jsonb_build_object('title', 'Card ' || k.code)); end if;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.drive_items (drive, wedding_key, title, what, size_label, note)
      values (d.id, nullif(left(it ->> 'wedding_key', 200), ''), left(coalesce(nullif(trim(it ->> 'title'), ''), 'Card ' || k.code), 160), case when is_bk then 'backup' else 'raw' end, nullif(trim(p_size), ''), left(label, 300))
      returning id into nid;
    ids := ids || nid;
  end loop;
  insert into public.card_copies (card, cycle, backup, drive, drive_name, folder, files, size_label, items, by_email, photos, videos, photo_size, video_size)
    values (k.id, k.cycle, is_bk, d.id, d.name, left(trim(p_folder), 200), p_files, nullif(left(trim(p_size), 20), ''), ids, public.my_email(), ph, vd, phs, vds);
  perform set_config('mutos.quiet', '1', true);
  update public.cards set data = case when is_bk then 'copied' else 'single' end, data_since = null where id = k.id;
  perform set_config('mutos.quiet', '', true);
  perform public.card_note(k.id, case when is_bk then 'Backup copied to ' else 'Copied to ' end || d.name || ' / ' || trim(p_folder) || ' (' || coalesce(split_txt, p_files || ' files') || coalesce(', ' || nullif(trim(p_size), ''), '') || ')' || case when is_bk then '. Safe: two copies.' else '. Single copy: safe to format, backup pending.' end);
  perform public.drive_note(d.id, (case when is_bk then 'Backup from card ' else 'Copied from card ' end) || k.code || ' into ' || trim(p_folder));
  return jsonb_build_object('ok', true, 'backup', is_bk, 'files', p_files);
end $$;
revoke all on function public.card_copy(uuid, uuid, text, int, text, jsonb, jsonb) from public, anon;
grant execute on function public.card_copy(uuid, uuid, text, int, text, jsonb, jsonb) to authenticated;

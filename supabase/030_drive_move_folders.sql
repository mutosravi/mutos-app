-- 030 (18 Nov 2026, Ravi: "Need an option to move a folder or multiple folders to a specific location in the same drive, when a
-- folder is named wrong"). Run after 029.
-- The drive page works out the new folder of every line inside the picked folders (moving "Sharma" into "2026" makes
-- "Sharma/Haldi" → "2026/Sharma/Haldi"; renaming changes the last name) and sends them here in one go, so either everything
-- moves or nothing does, with one line in the drive's history. Only on the same drive, only for whoever may edit that drive's
-- data (the studio or whoever holds it, as in 016). Nothing else on a line changes; card links stay.

create or replace function public.drive_set_paths(p_drive uuid, p_moves jsonb, p_label text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare d public.drives; n int; ok int; m jsonb;
begin
  select * into d from public.drives where id = p_drive;
  if d.id is null then return jsonb_build_object('error', 'Unknown drive.'); end if;
  if not public.can_drive(d.id) then return jsonb_build_object('error', 'Only the studio or whoever has ' || d.name || ' can move its folders.'); end if;
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 then return jsonb_build_object('error', 'Pick the folders to move.'); end if;
  n := jsonb_array_length(p_moves);
  if n > 20000 then return jsonb_build_object('error', 'Too many at once.'); end if;
  select count(distinct i.id) into ok from jsonb_array_elements(p_moves) x join public.drive_items i on i.id = (x ->> 'id')::uuid
    where i.drive = d.id and i.removed_at is null;
  if ok <> n then return jsonb_build_object('error', 'Some of these are no longer on ' || d.name || '. Open the drive again and retry.'); end if;
  for m in select * from jsonb_array_elements(p_moves) loop
    if public.drive_path(m ->> 'path') is null then return jsonb_build_object('error', 'Every item needs a folder to go to.'); end if;
  end loop;
  perform set_config('mutos.quiet', '1', true);
  update public.drive_items i set path = public.drive_path(x ->> 'path')
    from jsonb_array_elements(p_moves) x where i.id = (x ->> 'id')::uuid and i.drive = d.id;
  perform set_config('mutos.quiet', '', true);
  perform public.drive_note(d.id, left(coalesce(nullif(trim(p_label), ''), 'Folders moved'), 300) || ' (' || n || ' item' || case when n = 1 then '' else 's' end || ', ' || public.me_label() || ')');
  return jsonb_build_object('ok', true, 'moved', n);
end $$;
revoke all on function public.drive_set_paths(uuid, jsonb, text) from public, anon;
grant execute on function public.drive_set_paths(uuid, jsonb, text) to authenticated;

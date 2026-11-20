-- 033 (20 Nov 2026, Ravi: "Deleted this folder option from a drive, so that whenever data is deleted that can also be updated on
-- app"). Run after 032.
-- On the drive's Finder view, tick folders / items and mark them deleted from the drive in one go (the folder and every subfolder).
-- Lines are never really deleted: they are marked removed (as before, with the reason) and can be brought back.
--   · drive_delete_lines(drive, items[], why, check, last_ok): check = true only reports what would happen:
--       last  = the lines that are the ONLY copy of that data (no backup line, no copy on another drive, no other live copy of the
--               same card round, no line of the same title and kind elsewhere)
--       cards = cards that would go back to ON HOLD (no copy left) or to single copy (one left)
--     Deleting a last copy needs last_ok, and only the admin or a manager may do it (whoever holds the drive may delete the rest).
--     All or nothing; one line in the drive's history; the cards are re-counted by 024's trigger as each line goes.
--   · drive_restore_lines(drive, items[], why): admin / manager bring back several lines at once (moved ones are skipped).

-- the reason may now be written in words ("Client delivered", "Space needed" …); the old short values stay valid
alter table public.drive_items drop constraint if exists drive_items_removed_why_check;
alter table public.drive_items add constraint drive_items_removed_why_check check (length(removed_why) between 1 and 200);

-- the other live copies of a line (not counting lines in p_skip)
create or replace function public.drive_line_has_copy(p_item uuid, p_skip uuid[]) returns boolean
  language sql stable security definer set search_path = public as $$
  with l as (select * from public.drive_items where id = p_item)
  select exists (
    select 1 from public.drive_items x, l
    where x.id <> l.id and not (x.id = any(p_skip)) and (x.removed_at is null or x.moved_to is not null)
      and (x.from_item = l.id or x.id = l.from_item
           or (x.from_item is not null and x.from_item = l.from_item)
           or (x.drive <> l.drive and lower(trim(x.title)) = lower(trim(l.title)) and (x.what = l.what or x.what = 'backup' or l.what = 'backup'))))
  or exists (   -- another copy of the same card round still on a drive
    select 1 from public.card_copies c0 join public.cards k on k.id = c0.card and c0.cycle = k.cycle
    join public.card_copies c1 on c1.card = c0.card and c1.cycle = c0.cycle and c1.id <> c0.id
    where p_item = any(c0.items)
      and exists (select 1 from public.drive_items y where y.id = any(c1.items) and not (y.id = any(p_skip)) and (y.removed_at is null or y.moved_to is not null))) $$;

create or replace function public.drive_delete_lines(p_drive uuid, p_items uuid[], p_why text, p_check boolean, p_last_ok boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare d public.drives; n int; w text := left(coalesce(nullif(trim(p_why), ''), 'deleted'), 200); last jsonb; cards jsonb; titles text;
begin
  select * into d from public.drives where id = p_drive;
  if d.id is null then return jsonb_build_object('error', 'Unknown drive.'); end if;
  if not public.can_drive(d.id) then return jsonb_build_object('error', 'Only the studio or whoever has ' || d.name || ' can mark data deleted from it.'); end if;
  n := coalesce(array_length(p_items, 1), 0);
  if n = 0 then return jsonb_build_object('error', 'Pick the folders that were deleted.'); end if;
  if n > 20000 then return jsonb_build_object('error', 'Too many at once.'); end if;
  if (select count(distinct id) from public.drive_items where id = any(p_items) and drive = d.id and removed_at is null) <> (select count(distinct x) from unnest(p_items) x) then
    return jsonb_build_object('error', 'Some of these are no longer on ' || d.name || '. Open the drive again and retry.'); end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'what', i.what, 'path', i.path, 'no_backup', i.no_backup) order by i.title), '[]'::jsonb) into last
    from public.drive_items i where i.id = any(p_items) and not public.drive_line_has_copy(i.id, p_items);
  -- cards whose current round would lose copies: alive after = copies of this round with a live line outside the set
  select coalesce(jsonb_agg(jsonb_build_object('code', k.code, 'now', k.data, 'after', a.after) order by k.code), '[]'::jsonb) into cards
    from public.cards k
    join lateral (select case when count(*) >= 2 then 'copied' when count(*) = 1 then 'single' else 'hold' end as after
                  from public.card_copies cc where cc.card = k.id and cc.cycle = k.cycle
                    and exists (select 1 from public.drive_items y where y.id = any(cc.items) and not (y.id = any(p_items)) and (y.removed_at is null or y.moved_to is not null))) a on true
    where k.data in ('single', 'copied')
      and exists (select 1 from public.card_copies cc where cc.card = k.id and cc.cycle = k.cycle and cc.items && p_items)
      and a.after <> k.data and not (a.after = 'single' and k.no_backup_cycle is not distinct from k.cycle);

  if coalesce(p_check, false) then return jsonb_build_object('ok', true, 'check', true, 'count', n, 'last', last, 'cards', cards); end if;
  if jsonb_array_length(last) > 0 then
    if not public.is_staff() then return jsonb_build_object('error', 'Some of this is the ONLY copy (' || (select string_agg(x ->> 'title', ', ') from jsonb_array_elements(last) x) || '). Only the admin or a manager can mark it deleted.', 'last', last); end if;
    if not coalesce(p_last_ok, false) then return jsonb_build_object('error', 'Some of this is the only copy. Tick "I know this is the only copy" first.', 'last', last); end if;
  end if;

  perform set_config('mutos.quiet', '1', true);
  update public.drive_items set removed_at = now(), removed_why = w where id = any(p_items) and drive = d.id and removed_at is null;
  perform set_config('mutos.quiet', '', true);
  select string_agg(distinct coalesce(path, title), ', ') into titles from public.drive_items where id = any(p_items);
  perform public.drive_note(d.id, left('Deleted from the drive (' || w || '): ' || titles, 500) || ' (' || n || ' item' || case when n = 1 then '' else 's' end
    || case when jsonb_array_length(last) > 0 then ', ' || jsonb_array_length(last) || ' of them the only copy' else '' end || ', ' || public.me_label() || ')');
  return jsonb_build_object('ok', true, 'deleted', n, 'last', last, 'cards', cards);
end $$;
revoke all on function public.drive_delete_lines(uuid, uuid[], text, boolean, boolean) from public, anon;
grant execute on function public.drive_delete_lines(uuid, uuid[], text, boolean, boolean) to authenticated;
revoke all on function public.drive_line_has_copy(uuid, uuid[]) from public, anon;

create or replace function public.drive_restore_lines(p_drive uuid, p_items uuid[], p_why text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare d public.drives; n int; titles text;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can bring back removed data.'); end if;
  select * into d from public.drives where id = p_drive;
  if d.id is null then return jsonb_build_object('error', 'Unknown drive.'); end if;
  if coalesce(trim(p_why), '') = '' then return jsonb_build_object('error', 'Write why (e.g. "removed by mistake").'); end if;
  select string_agg(distinct coalesce(path, title), ', ') into titles from public.drive_items
    where id = any(p_items) and drive = d.id and removed_at is not null and moved_to is null;
  perform set_config('mutos.restore', '1', true); perform set_config('mutos.quiet', '1', true);
  update public.drive_items set removed_at = null, removed_why = null where id = any(p_items) and drive = d.id and removed_at is not null and moved_to is null;
  get diagnostics n = row_count;
  perform set_config('mutos.restore', '', true); perform set_config('mutos.quiet', '', true);
  if n = 0 then return jsonb_build_object('error', 'Nothing to bring back (moved data is listed on the other drive).'); end if;
  perform public.drive_note(d.id, left('Data brought back: ' || titles, 500) || ' (' || n || ' item' || case when n = 1 then '' else 's' end || ', ' || public.me_label() || ': ' || left(trim(p_why), 200) || ')');
  return jsonb_build_object('ok', true, 'restored', n);
end $$;
revoke all on function public.drive_restore_lines(uuid, uuid[], text) from public, anon;
grant execute on function public.drive_restore_lines(uuid, uuid[], text) to authenticated;

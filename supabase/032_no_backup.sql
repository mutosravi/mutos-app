-- 032 (20 Nov 2026, Ravi: "Sometime some data does not require backup, add an option that says no backup required and it
-- automatically turns card status to free or copied instead of single copy"). Run after 031.
-- Admin or manager decides that one copy is enough (or that the footage is not needed at all):
--   · card_no_backup(card, why, free): a card with one copy (single, amber) turns copied (green: safe to format) or, with free,
--     empty (free to use again). It is remembered for this round (cards.no_backup_cycle), so removing / bringing back drive
--     lines (024) does not turn it amber again while one copy is still listed.
--   · drive_no_backup(item, why, free): a folder on a drive that needs no backup: the drive shows "no backup needed" instead of
--     "no backup", and every card whose copy made that folder (this round, still single) is set as above.
--   · drive_need_backup(item): undo for a folder; its cards go back to what their copies say (single when one copy).
-- Every change is in the card's history and the drive's history.

alter table public.cards add column if not exists no_backup_cycle int;
alter table public.drive_items add column if not exists no_backup boolean not null default false;
alter table public.drive_items add column if not exists no_backup_why text check (length(no_backup_why) <= 200);

create or replace function public.card_no_backup(p_card uuid, p_why text, p_free boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare k public.cards; w text := left(coalesce(nullif(trim(p_why), ''), 'No backup needed'), 200);
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can decide that no backup is needed.'); end if;
  select * into k from public.cards where id = p_card; if not found then return jsonb_build_object('error', 'Unknown card.'); end if;
  if k.data = 'hold' then return jsonb_build_object('error', k.code || ' is not copied anywhere yet. Copy it to a drive first (or "Checked: nothing on it").'); end if;
  if k.data = 'empty' then return jsonb_build_object('error', k.code || ' is already free.'); end if;
  if k.data = 'copied' and not coalesce(p_free, false) then return jsonb_build_object('ok', true, 'data', 'copied'); end if;
  perform set_config('mutos.quiet', '1', true);
  update public.cards set data = case when p_free then 'empty' else 'copied' end, data_since = null, no_backup_cycle = k.cycle where id = k.id;
  perform set_config('mutos.quiet', '', true);
  perform public.card_note(k.id, 'No backup needed (' || w || '): ' || case when p_free then 'marked FREE, can be formatted and used again' else 'marked copied, safe to format' end || ' by ' || public.me_label() || '.');
  return jsonb_build_object('ok', true, 'data', case when p_free then 'empty' else 'copied' end);
end $$;
revoke all on function public.card_no_backup(uuid, text, boolean) from public, anon;
grant execute on function public.card_no_backup(uuid, text, boolean) to authenticated;

create or replace function public.drive_no_backup(p_item uuid, p_why text, p_free boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare it public.drive_items; w text := left(coalesce(nullif(trim(p_why), ''), 'No backup needed'), 200); cc record; done text[] := '{}'; dn text;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can decide that no backup is needed.'); end if;
  select * into it from public.drive_items where id = p_item and removed_at is null; if not found then return jsonb_build_object('error', 'That folder is no longer on the drive.'); end if;
  select name into dn from public.drives where id = it.drive;
  perform set_config('mutos.quiet', '1', true);
  update public.drive_items set no_backup = true, no_backup_why = w where id = it.id;
  perform set_config('mutos.quiet', '', true);
  perform public.drive_note(it.drive, 'No backup needed for ' || it.title || ' (' || w || ', ' || public.me_label() || ')');
  for cc in select distinct k.id, k.code from public.card_copies c0 join public.cards k on k.id = c0.card
            where (it.id = any(c0.items) or (it.from_item is not null and it.from_item = any(c0.items))) and c0.cycle = k.cycle and k.data = 'single' loop
    perform public.card_no_backup(cc.id, w || ' · folder ' || it.title || ' on ' || coalesce(dn, 'a drive'), p_free);
    done := done || cc.code;
  end loop;
  return jsonb_build_object('ok', true, 'cards', to_jsonb(done));
end $$;
revoke all on function public.drive_no_backup(uuid, text, boolean) from public, anon;
grant execute on function public.drive_no_backup(uuid, text, boolean) to authenticated;

create or replace function public.drive_need_backup(p_item uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare it public.drive_items; cid uuid;
begin
  if not public.is_staff() then return jsonb_build_object('error', 'Only the admin or the manager can change this.'); end if;
  select * into it from public.drive_items where id = p_item; if not found then return jsonb_build_object('error', 'Unknown folder.'); end if;
  perform set_config('mutos.quiet', '1', true);
  update public.drive_items set no_backup = false, no_backup_why = null where id = it.id;
  perform set_config('mutos.quiet', '', true);
  perform public.drive_note(it.drive, 'Backup needed again for ' || it.title || ' (' || public.me_label() || ')');
  for cid in select distinct k.id from public.card_copies c0 join public.cards k on k.id = c0.card
             where it.id = any(c0.items) and c0.cycle = k.cycle and k.no_backup_cycle = k.cycle and k.data = 'copied' loop
    update public.cards set no_backup_cycle = null where id = cid;
    perform public.card_recount(cid, 'Backup needed again for ' || it.title);
  end loop;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.drive_need_backup(uuid) from public, anon;
grant execute on function public.drive_need_backup(uuid) to authenticated;

-- 024's recount, now remembering "no backup needed" for this round: one copy left still counts as copied
create or replace function public.card_recount(p_card uuid, p_why text) returns void language plpgsql security definer set search_path = public as $$
declare k public.cards; n int; want text;
begin
  select * into k from public.cards where id = p_card;
  if not found or k.data = 'empty' then return; end if;
  if not exists (select 1 from public.card_copies where card = k.id and cycle = k.cycle) then return; end if;
  n := public.card_copies_alive(k.id);
  want := case when n >= 2 then 'copied' when n = 1 then 'single' else 'hold' end;
  if want = 'single' and k.no_backup_cycle = k.cycle then want := 'copied'; end if;
  if want = k.data then return; end if;
  perform set_config('mutos.quiet', '1', true);
  update public.cards set data = want, data_since = case when want = 'hold' then now() else null end where id = k.id;
  perform set_config('mutos.quiet', '', true);
  perform public.card_note(k.id, p_why || ': ' || case want when 'hold' then 'no copy left on any drive. Back ON HOLD: do not format.'
    when 'single' then 'one copy left. Single copy again: backup needed.' else case when k.no_backup_cycle = k.cycle then 'copy on a drive again (no backup needed).' else 'copy and backup on drives again.' end end);
end $$;

-- 024: a card's status follows its drive copies (12 Nov 2026, Ravi: "Entry removed from drive but card still shows single copy
-- or copied"). Run after 023.
-- When the drive line made by a card copy is removed (not moved) and the card still holds that footage (same round, not handed out
-- and formatted since), the card is re-counted from the copies that are still on a drive:
--   2 or more copies left → copied (green) · 1 left → single (amber) · none left → hold (red: do not format)
-- Bringing the line back (drive_item_restore, 023) counts again, so the card goes back up. A line MOVED to another drive is still a
-- copy (the data is on the other drive). A card already in a later round (formatted, reused) is not touched: its old footage lives
-- only on the drives, and the client's "Data copied" warns when a copy is missing.

-- copies of this card's CURRENT round that still have at least one line on a drive (a moved line counts: it lives on)
create or replace function public.card_copies_alive(p_card uuid) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.card_copies cc join public.cards k on k.id = cc.card
  where cc.card = p_card and cc.cycle = k.cycle
    and exists (select 1 from public.drive_items i where i.id = any(cc.items) and (i.removed_at is null or i.moved_to is not null)) $$;

create or replace function public.card_recount(p_card uuid, p_why text) returns void language plpgsql security definer set search_path = public as $$
declare k public.cards; n int; want text;
begin
  select * into k from public.cards where id = p_card;
  if not found or k.data = 'empty' then return; end if;                     -- nothing on it to protect
  if not exists (select 1 from public.card_copies where card = k.id and cycle = k.cycle) then return; end if;   -- never copied this round
  n := public.card_copies_alive(k.id);
  want := case when n >= 2 then 'copied' when n = 1 then 'single' else 'hold' end;
  if want = k.data then return; end if;
  perform set_config('mutos.quiet', '1', true);
  update public.cards set data = want, data_since = case when want = 'hold' then now() else null end where id = k.id;
  perform set_config('mutos.quiet', '', true);
  perform public.card_note(k.id, p_why || ': ' || case want when 'hold' then 'no copy left on any drive. Back ON HOLD: do not format.'
    when 'single' then 'one copy left. Single copy again: backup needed.' else 'copy and backup on drives again.' end);
end $$;

-- after a drive line is removed or brought back
create or replace function public.drive_items_card_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare cid uuid; dn text;
begin
  if (old.removed_at is null) = (new.removed_at is null) then return null; end if;
  if new.removed_at is not null and new.moved_to is not null then return null; end if;   -- moved: the data lives on
  select name into dn from public.drives where id = new.drive;
  for cid in select distinct card from public.card_copies where new.id = any(items) loop
    perform public.card_recount(cid, case when new.removed_at is null then 'Line on ' || coalesce(dn, 'a drive') || ' brought back' else 'Line removed from ' || coalesce(dn, 'a drive') end);
  end loop;
  return null;
end $$;
drop trigger if exists drive_items_card_trg on public.drive_items;
create trigger drive_items_card_trg after update of removed_at on public.drive_items for each row execute function public.drive_items_card_trg();

revoke all on function public.card_copies_alive(uuid), public.card_recount(uuid, text) from public, anon, authenticated;

-- once: cards whose copy lines were already removed before this file
do $$ declare k record; begin
  for k in select id from public.cards where data in ('single', 'copied') loop perform public.card_recount(k.id, 'Checked against the drives'); end loop;
end $$;

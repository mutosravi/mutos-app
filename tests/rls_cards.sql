-- Test for supabase/014_cards.sql (after pg_stub, schema, 002–005, 007–013, 014).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('s@x.com','supervisor',null,'Sup',now()),
  ('shrey@x.com','crew','shrey','Shrey',now()),('saif@x.com','crew','saif','Saif',now()),('kuldeep@x.com','staff',null,'Kuldeep',now()) on conflict do nothing;
update people set email = 'shrey@x.com' where name = 'Shrey';
update people set email = 'saif@x.com' where name = 'Saif';
update people set email = 'kuldeep@x.com', skills = '{data}' where name = 'Kuldeep';
insert into people (name, email) values ('Supervisor', 's@x.com'), ('Manager', 'm@x.com');
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS %: refused (%)', label, sqlerrm; return; end;
  raise exception 'FAIL %: was allowed', label;
end $$;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text), pg_temp.expect_fail(text, text) to authenticated, anon;
select set_config('t.shrey', (select id::text from people where name = 'Shrey'), false), set_config('t.saif', (select id::text from people where name = 'Saif'), false),
       set_config('t.sup', (select id::text from people where name = 'Supervisor'), false);
insert into drives (name, kind) values ('M 5', 'SSD'), ('Dibba 2', 'HDD');
select set_config('t.m5', (select id::text from drives where name = 'M 5'), false), set_config('t.d2', (select id::text from drives where name = 'Dibba 2'), false);

-- ── register ──
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into cards (code, kind, size_label, brand, serial) values (' C01 ', 'CFexpress B', '256 GB', 'Sony', 'SN-1'), ('C02', 'SD', '128 GB', 'SanDisk', 'SN-2'), ('C03', 'SD', '128 GB', 'SanDisk', null), ('C04', 'SD', '64 GB', 'Lexar', '');
select pg_temp.check((select count(*) from cards) = 4 and exists (select 1 from cards where code = 'C01'), 'the manager adds cards (codes tidied)');
select pg_temp.expect_fail($$insert into cards (code) values ('c01')$$, 'two cards with the same code');
select pg_temp.expect_fail($$insert into cards (code, serial) values ('C09', 'sn-2')$$, 'two cards with the same serial number');
select set_config('t.c1', (select id::text from cards where code = 'C01'), false), set_config('t.c2', (select id::text from cards where code = 'C02'), false),
       set_config('t.c3', (select id::text from cards where code = 'C03'), false), set_config('t.c4', (select id::text from cards where code = 'C04'), false);
select pg_temp.expect_fail($$update cards set holder = current_setting('t.shrey')::uuid where code = 'C01'$$, 'handing a card over by editing it');
select pg_temp.expect_fail($$update cards set data = 'copied' where code = 'C01'$$, 'marking copied by editing it');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.expect_fail($$insert into cards (code) values ('C10')$$, 'the supervisor adding cards');
select pg_temp.check((select count(*) from cards) = 4, 'the supervisor sees the cards');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((select count(*) from cards) = 4, 'the team sees the cards too');
select pg_temp.check((card_give(array[current_setting('t.c1')::uuid], current_setting('t.shrey')::uuid)) ? 'error', 'a team member cannot give office cards');
reset role;

-- ── office → supervisor (bulk) → team leader ──
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((card_give(array[current_setting('t.c1')::uuid, current_setting('t.c2')::uuid, current_setting('t.c3')::uuid, current_setting('t.c4')::uuid], current_setting('t.sup')::uuid, 'for the weekend')) ? 'ok', 'the manager gives four cards to the supervisor at once');
select pg_temp.check((select count(distinct batch) from card_moves) = 1 and (select count(*) from cards where holder is null) = 4, 'one batch; still in the office until he accepts');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((card_answer(array(select id from card_moves where status = 'pending'), true)) ->> 'count' = '4', 'the supervisor accepts all four');
select pg_temp.check((card_give(array[current_setting('t.c1')::uuid, current_setting('t.c2')::uuid, current_setting('t.c3')::uuid], current_setting('t.shrey')::uuid)) ? 'ok', 'and gives three to Shrey (team leader)');
set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((card_answer(array(select id from card_moves where status = 'pending'), true)) ? 'error', 'Saif cannot accept cards meant for Shrey');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((card_answer(array(select id from card_moves where status = 'pending'), true)) ? 'ok', 'Shrey accepts');
reset role;
select pg_temp.check((select count(*) from cards where holder = current_setting('t.shrey')::uuid and with_team) = 3, 'three cards are now with Shrey');

-- ── notes per card ──
set role authenticated; set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((card_use(current_setting('t.c1')::uuid, true, 'e1', 'Sharma Haldi', 'Sharma', 'photo', 'candid', 'Z9', null)) ? 'error', 'Saif cannot write notes on Shrey''s card');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((card_use(current_setting('t.c1')::uuid, true, 'e1', 'Sharma Haldi', 'Sharma', 'photo', 'candid', 'Z9', 'family portraits')) ? 'ok', 'Shrey notes C01: Haldi, candid photo');
select pg_temp.check((card_use(current_setting('t.c2')::uuid, true, 'e1', 'Sharma Haldi', 'Sharma', 'video', 'cine', null, null)) ? 'ok', 'C02: cine video');
select pg_temp.check((card_use(current_setting('t.c3')::uuid, false, null, null, null, null, null, null, 'spare')) ? 'ok', 'C03: not used');
select pg_temp.check((card_use(current_setting('t.c2')::uuid, true, '', '', null, null, null, null, null)) ? 'error', 'a used card needs its shoot');
reset role;
select pg_temp.check((select data from cards where code = 'C01') = 'hold' and (select data from cards where code = 'C03') = 'empty', 'used cards go on hold (red); the unused one stays empty');
-- Shrey passes C02 to Saif (next shoot, no office in between)
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((card_give(array[current_setting('t.c2')::uuid], current_setting('t.saif')::uuid, 'Sharma wedding')) ? 'ok', 'a team leader passes a card to another team leader');
set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((card_answer(array(select id from card_moves where status = 'pending' and card = current_setting('t.c2')::uuid), true)) ? 'ok', 'Saif accepts it');
reset role;
select pg_temp.check((select data from cards where code = 'C02') = 'hold', 'a card on hold stays on hold when it is passed on');
-- returns: C01 + C03 to the supervisor, C02 straight to the office
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((card_give(array[current_setting('t.c1')::uuid, current_setting('t.c3')::uuid], current_setting('t.sup')::uuid)) ? 'ok', 'Shrey hands two cards to the supervisor');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((card_answer(array(select id from card_moves where status = 'pending'), true)) ? 'ok', 'the supervisor accepts them');
select pg_temp.check((card_copy(current_setting('t.c1')::uuid, current_setting('t.m5')::uuid, 'Sharma/Haldi', 812, '120 GB', '[]')) ? 'error', 'the supervisor cannot mark a card copied');
select pg_temp.check((card_give(array[current_setting('t.c1')::uuid, current_setting('t.c3')::uuid, current_setting('t.c4')::uuid], null)) ? 'ok', 'and passes them on to the office');
set request.jwt.claims = '{"email":"kuldeep@x.com"}';
select pg_temp.check((card_answer(array(select id from card_moves where status = 'pending'), true)) ? 'error', 'only the owner or manager accepts cards into the office');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((card_answer(array(select id from card_moves where status = 'pending'), true)) ? 'ok', 'the manager accepts them');
set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((card_give(array[current_setting('t.c2')::uuid], null)) ? 'ok', 'Saif gives C02 back to the office');
set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((card_answer(array(select id from card_moves where status = 'pending'), true)) ? 'ok', 'the owner accepts it');
reset role;
select pg_temp.check((select count(*) from cards where holder is null) = 4, 'all four back in the office');
select pg_temp.check((select data from cards where code = 'C04') = 'empty', 'C04 only went to the supervisor: no notes needed, still empty');

-- ── copying ──
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((card_give(array[current_setting('t.c1')::uuid], current_setting('t.saif')::uuid)) ? 'error', 'a card on hold cannot go out again before it is copied');
select pg_temp.check((card_copy(current_setting('t.c1')::uuid, current_setting('t.m5')::uuid, 'Sharma/Haldi', 0, null, '[]')) ? 'error', 'copied needs the number of files');
select pg_temp.check((card_copy(current_setting('t.c1')::uuid, current_setting('t.m5')::uuid, 'Sharma/Haldi/Candid', 812, '120 GB', '[{"title":"Sharma · Haldi","wedding_key":"w:sharma"}]')) ->> 'backup' = 'false', 'the manager marks C01 copied to M 5');
select pg_temp.check((select data from cards where code = 'C01') = 'single', 'C01 is now single copy (amber: safe to format, backup pending)');
select pg_temp.check((select count(*) from drive_items where drive = current_setting('t.m5')::uuid and wedding_key = 'w:sharma' and what = 'raw' and note like 'from card C01%812 files%') = 1, 'M 5''s contents got the line automatically');
select pg_temp.check((card_copy(current_setting('t.c1')::uuid, current_setting('t.m5')::uuid, 'Backup', 812, null, '[]')) ? 'error', 'the backup must be on another drive');
select pg_temp.check((card_copy(current_setting('t.c1')::uuid, current_setting('t.d2')::uuid, 'Sharma/Haldi', 812, null, '[{"title":"Sharma · Haldi","wedding_key":"w:sharma"}]')) ->> 'backup' = 'true', 'backup to Dibba 2');
select pg_temp.check((select data from cards where code = 'C01') = 'copied', 'C01 is green: copied with backup');
select pg_temp.check((card_copy(current_setting('t.c1')::uuid, current_setting('t.d2')::uuid, 'x', 1, null, '[]')) ? 'error', 'nothing left to copy');
reset role;
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((select count(*) from card_copies c join cards k on k.id = c.card where k.code = 'C01') = 2, 'Shrey can see where his card was copied');
select pg_temp.check((card_use_remove((select id from card_uses where card = current_setting('t.c1')::uuid))) ? 'error', 'a note on a copied card cannot be removed');
reset role;

-- ── back out: a new round; old copies stay ──
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((card_give(array[current_setting('t.c1')::uuid], current_setting('t.saif')::uuid)) ? 'ok', 'a copied card can go out again');
set request.jwt.claims = '{"email":"saif@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
reset role;
select pg_temp.check((select data = 'empty' and cycle = 2 from cards where code = 'C01') and (select count(*) from card_copies where card = current_setting('t.c1')::uuid) = 2, 'C01 starts a new round (empty); the old copy record stays');
-- a card that comes back from a team with no notes stays on hold
set role authenticated; set request.jwt.claims = '{"email":"saif@x.com"}';
select card_give(array[current_setting('t.c1')::uuid], null);
set request.jwt.claims = '{"email":"m@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
reset role;
select pg_temp.check((select data from cards where code = 'C01') = 'hold', 'back from a team without notes: on hold until checked');
set role authenticated; set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((card_mark_empty(current_setting('t.c1')::uuid, 'checked')) ? 'error', 'only the owner or manager clears a hold');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((card_mark_empty(current_setting('t.c1')::uuid, '')) ? 'error', 'clearing a hold needs a reason');
select pg_temp.check((card_mark_empty(current_setting('t.c1')::uuid, 'checked: card is empty')) ? 'ok', 'the manager checked it: empty');
-- single copy: giving it out is allowed, with a warning
select card_copy(current_setting('t.c2')::uuid, current_setting('t.m5')::uuid, 'Sharma/Haldi/Cine', 40, null, '[]');
select pg_temp.check((card_give(array[current_setting('t.c2')::uuid], current_setting('t.shrey')::uuid)) -> 'single_copy' ? 'C02', 'giving out a single-copy card warns that the backup is not done');
reset role;

-- ── problems ──
set role authenticated; set request.jwt.claims = '{"email":"saif@x.com"}';
select pg_temp.check((card_problem(current_setting('t.c3')::uuid, 'lost', null)) ? 'error', 'only whoever has a card can report it lost');
set request.jwt.claims = '{"email":"m@x.com"}';
select card_problem(current_setting('t.c3')::uuid, 'error', 'read error');
select pg_temp.check((select condition from cards where code = 'C03') = 'ok', 'one error: still in use');
select card_problem(current_setting('t.c3')::uuid, 'error', 'corrupt files');
select pg_temp.check((select condition from cards where code = 'C03') = 'retired', 'two errors: retired automatically');
select pg_temp.check((card_give(array[current_setting('t.c3')::uuid], current_setting('t.saif')::uuid)) ? 'error', 'a retired card cannot go out');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((card_problem(current_setting('t.c3')::uuid, 'ok', null)) ? 'error', 'only the owner or manager puts a card back in use');
reset role;
select pg_temp.check((select count(*) from card_log where card = current_setting('t.c1')::uuid) >= 8, 'every step is in the card''s history');
set role anon;
select pg_temp.expect_fail($$select count(*) from cards$$, 'nothing for visitors');
reset role;
select 'ALL CARD CHECKS PASSED';

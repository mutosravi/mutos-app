-- Test for supabase/022_card_history.sql (after pg_stub, schema and every file up to 021, then 022).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('m@x.com','manager',null,'Partner',now()),('s@x.com','supervisor',null,'Sup',now()),
  ('shrey@x.com','crew','shrey','Shrey',now()),('saif@x.com','crew','saif','Saif',now()),('kuldeep@x.com','staff',null,'Kuldeep',now()) on conflict do nothing;
update people set email = 'shrey@x.com' where name = 'Shrey';
update people set email = 'saif@x.com' where name = 'Saif';
insert into people (name, email) values ('Ravi', 'o@x.com'), ('Supervisor', 's@x.com'), ('Manager', 'm@x.com');
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
select set_config('t.shrey', (select id::text from people where name = 'Shrey'), false);
insert into drives (name, kind) values ('M 5', 'SSD'), ('Dibba 2', 'HDD');
select set_config('t.m5', (select id::text from drives where name = 'M 5'), false), set_config('t.d2', (select id::text from drives where name = 'Dibba 2'), false);
insert into docs (collection, id, data) values
  ('events', 'e1', '{"id":"e1","name":"Sharma Haldi","wedding":"Sharma","date":"2026-10-01","slot":"Morning","contactName":"Rahul Sharma","contactPhone":"9876500000"}'),
  ('events', 'e2', '{"id":"e2","name":"Gupta Mehndi","wedding":"Gupta","date":"2027-01-10","slot":"Evening","contactName":"Neha Gupta"}'),
  ('events', 'e3', '{"id":"e3","name":"Old cancelled","date":"2026-09-01","status":"cancelled"}');

-- ── the picker: every shoot, past and future, with the client name, no phone ──
set role authenticated; set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check(jsonb_array_length(card_shoots()) = 2, 'a team leader sees every shoot (past and future), not the cancelled one');
select pg_temp.check((select bool_and(x ? 'wedding' and x ? 'contactName' and not x ? 'contactPhone') from jsonb_array_elements(card_shoots()) x), '… with the wedding and client name, never the phone');
select pg_temp.check((select count(*) from docs) = 0, 'the board itself stays closed to the team');
set request.jwt.claims = '{"email":"kuldeep@x.com"}';
select pg_temp.check(jsonb_array_length(card_shoots()) = 0, 'someone not on People gets no shoots');
reset role;

-- ── a card goes out, is used for Sharma Haldi, comes back, is copied ──
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
insert into cards (code, kind) values ('C01', 'SD');
select set_config('t.c1', (select id::text from cards where code = 'C01'), false);
select card_give(array[current_setting('t.c1')::uuid], current_setting('t.shrey')::uuid);
set request.jwt.claims = '{"email":"shrey@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
select card_use(current_setting('t.c1')::uuid, true, 'e1', 'Sharma Haldi', 'Sharma', 'photo', 'candid', null, null);
select card_give(array[current_setting('t.c1')::uuid], null);
select pg_temp.check((select count(*) from client_log) = 0, 'the team cannot read the client history');
set request.jwt.claims = '{"email":"o@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
select pg_temp.check(exists (select 1 from card_log where what like 'Ravi (admin) received C01 for the office from Shrey%'), 'the card log says who received it for the office: Ravi (admin)');
select card_copy(current_setting('t.c1')::uuid, current_setting('t.m5')::uuid, 'Sharma/Haldi', 812, '120 GB', '[{"title":"Sharma · Haldi (Photo candid)","wedding_key":"w:sharma"}]');
select pg_temp.check((select count(*) from client_log where event_id = 'e1') >= 4, 'Sharma Haldi''s history: used, given, received by, copied (' || (select count(*) from client_log where event_id = 'e1') || ' lines)');
select pg_temp.check(exists (select 1 from client_log where event_id = 'e1' and what like 'C01: Ravi (admin) received%') and exists (select 1 from client_log where event_id = 'e1' and what like 'C01: Copied to M 5%'), '… including who received it and where it was copied');

-- ── the team wrote the wrong function: the admin moves it to Gupta Mehndi ──
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((card_use_edit((select id from card_uses limit 1), 'e2', 'Gupta Mehndi', 'Gupta', 'Gupta · Mehndi (Photo candid)', 'Sharma · Haldi (Photo candid)', 'w:gupta', 'wrong function')) ? 'error', 'the supervisor cannot move a note');
set request.jwt.claims = '{"email":"o@x.com"}';
select pg_temp.check((card_use_edit((select id from card_uses limit 1), 'e2', 'Gupta Mehndi', 'Gupta', 'Gupta · Mehndi (Photo candid)', 'Sharma · Haldi (Photo candid)', 'w:gupta', '')) ? 'error', 'a reason is needed');
select pg_temp.check((card_use_edit((select id from card_uses limit 1), 'e2', 'Gupta Mehndi', 'Gupta', 'Gupta · Mehndi (Photo candid)', 'Sharma · Haldi (Photo candid)', 'w:gupta', 'team wrote the wrong function')) ->> 'drive_lines' = '1', 'the admin moves the note; the drive line follows');
select pg_temp.check((select event_id || '|' || shoot from card_uses limit 1) = 'e2|Gupta Mehndi' and (select title || '|' || wedding_key from drive_items limit 1) = 'Gupta · Mehndi (Photo candid)|w:gupta', 'note and M 5''s line now say Gupta Mehndi');
select pg_temp.check(exists (select 1 from client_log where event_id = 'e1' and what like 'C01: moved from Sharma Haldi to Gupta Mehndi by Ravi (admin) (team wrote the wrong function)%'), 'Sharma Haldi''s history says where the footage went');
select pg_temp.check(exists (select 1 from client_log where event_id = 'e2' and what like 'C01: Note moved from Sharma Haldi to Gupta Mehndi%'), 'Gupta Mehndi''s history gets the line too');
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select count(*) from client_log) > 0, 'the manager reads the client history');
select pg_temp.check((card_use_edit((select id from card_uses limit 1), 'e2', 'Gupta Mehndi', 'Gupta', 'x', 'y', 'w:gupta', 'again')) ? 'error', 'moving to the same shoot is refused');
set request.jwt.claims = '{"email":"shrey@x.com"}';
select pg_temp.check((card_use_edit((select id from card_uses limit 1), 'e1', 'Sharma Haldi', 'Sharma', 'a', 'b', 'w:sharma', 'mine')) ? 'error', 'a team leader cannot move a note');
reset role;
select pg_temp.check((select count(*) from client_log where event_id = 'e1') >= 5, 'the history keeps everything (append-only)');
-- a note from an earlier round (the card went out again after being copied) moved back: the new shoot still gets its line
set role authenticated; set request.jwt.claims = '{"email":"m@x.com"}';
select card_copy(current_setting('t.c1')::uuid, current_setting('t.d2')::uuid, 'Gupta/Mehndi', 812, null, '[]');
select card_give(array[current_setting('t.c1')::uuid], current_setting('t.shrey')::uuid);
set request.jwt.claims = '{"email":"shrey@x.com"}';
select card_answer(array(select id from card_moves where status = 'pending'), true);
set request.jwt.claims = '{"email":"m@x.com"}';
select pg_temp.check((select cycle from cards where code = 'C01') = 2, 'C01 went out again: round 2');
select pg_temp.check(not ((card_use_edit((select id from card_uses limit 1), 'e1', 'Sharma Haldi', 'Sharma', 'Sharma · Haldi (Photo candid)', 'Gupta · Mehndi (Photo candid)', 'w:sharma', 'it was Sharma after all')) ? 'error'), 'the manager moves a round-1 note back');
select pg_temp.check(exists (select 1 from client_log where event_id = 'e1' and what like 'C01: footage of round 1 moved here from Gupta Mehndi by Manager (manager)%'), 'Sharma Haldi''s history gets "footage of round 1 moved here"');
select pg_temp.check((select count(*) from drive_items where title = 'Sharma · Haldi (Photo candid)' and wedding_key = 'w:sharma') = 2, 'both drive lines of round 1 follow back');
reset role;
-- "admin" wording: a function already in a database with the old words gets them rewritten when 022 runs (again)
create or replace function public.t_old_words() returns text language sql as $$ select 'Only the owner can correct this.' $$;
\ir ../supabase/022_card_history.sql
select pg_temp.check(public.t_old_words() = 'Only the admin can correct this.', 'messages say "admin" (the role stays owner)');
select pg_temp.check(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%Only the owner%'), 'no "Only the owner" left in any function');
select pg_temp.check((select count(*) from client_log where event_id = 'e1') >= 6, 'running 022 again keeps the history (no second backfill)');
drop function public.t_old_words();

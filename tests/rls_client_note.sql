-- Test for supabase/020_client_note_one_line.sql. Run after pg_stub, schema and every file up to 019 (NOT 020:
-- this test first shows the old 017 bug, then loads 020 itself).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into docs (collection, id, data) values
  ('events', 'e1', '{"id":"e1","name":"Akriti Haldi","date":"2026-12-01","slot":"Morning","location":"Lucknow","notes":"Bring the drone"}'),
  ('events', 'e2', '{"id":"e2","name":"Akriti Wedding","date":"2026-12-02","slot":"Evening","location":"Lucknow","notes":"Studio only"}');
insert into client_links (wedding_key, title, emails) values ('w:akriti', 'Akriti & Rohan', '{akriti@gmail.com}');
insert into client_feed (wedding_key, data) values ('w:akriti', '{"functions":[{"id":"e1","name":"Akriti Haldi"},{"id":"e2","name":"Akriti Wedding"}]}');
insert into crew_feed (person_key, name, data) values ('hamza', 'Hamza', '{"shoots":[{"id":"e1","shoot":"Akriti Haldi","venue":"Lucknow","notes":"Bring the drone"}]}');
select set_config('t.tok', (select token::text from client_links), false);
create or replace function pg_temp.send(j text) returns void language plpgsql as $$
begin
  set local role authenticated; perform set_config('request.jwt.claims', '{"email":"akriti@gmail.com"}', true);
  perform client_save(current_setting('t.tok')::uuid, j::jsonb, true);
end $$;

-- with 017: a note of three lines, sent three times (she edits the last line before the third Send)
begin; select pg_temp.send('{"e1":{"venue":"Taj","notes":"Couple entry 8 pm\nCover the grandmother\nVarmala at 9"}}'); commit;
begin; select pg_temp.send('{"e1":{"venue":"Taj","notes":"Couple entry 8 pm\nCover the grandmother\nVarmala at 9"}}'); commit;
begin; select pg_temp.send('{"e1":{"venue":"Taj","notes":"Couple entry 8 pm\nCover the grandmother\nVarmala at 9:30"}}'); commit;
select pg_temp.check((select data ->> 'notes' from docs where id = 'e1') like '%Cover the grandmother%Cover the grandmother%', 'the old 017 piles up the family''s extra lines (the bug Ravi saw)');
\echo before: 
select data ->> 'notes' from docs where id = 'e1';

\ir ../supabase/020_client_note_one_line.sql
\echo after:
select data ->> 'notes' from docs where id = 'e1';
select pg_temp.check((select data ->> 'notes' from docs where id = 'e1') = E'Bring the drone\nFrom client: Couple entry 8 pm · Cover the grandmother · Varmala at 9:30', 'clean-up: studio line kept, one family line with the latest answers');
select pg_temp.check((select s ->> 'notes' from crew_feed, jsonb_array_elements(data -> 'shoots') s where s ->> 'id' = 'e1') = E'Bring the drone\nFrom client: Couple entry 8 pm · Cover the grandmother · Varmala at 9:30', 'clean-up reaches the crew page too');
select pg_temp.check((select data ->> 'notes' from docs where id = 'e2') = 'Studio only', 'a shoot the family never sent is untouched');
select pg_temp.check((select data ->> 'location' from docs where id = 'e1') = 'Taj', 'venue untouched by the clean-up');

-- the studio adds a line, then the family sends again with a different multi-line note
update docs set data = data || jsonb_build_object('notes', data ->> 'notes' || E'\nTwo drones please') where id = 'e1';
begin; select pg_temp.send('{"e1":{"venue":"Taj","time":"19:30","notes":"Couple entry 8 pm\n\nVarmala at 10"}}'); commit;
begin; select pg_temp.send('{"e1":{"venue":"Taj","time":"19:30","notes":"Couple entry 8 pm\n\nVarmala at 10"}}'); commit;
select pg_temp.check((select data ->> 'notes' from docs where id = 'e1') = E'Bring the drone\nTwo drones please\nFrom client: starts 7:30 pm · Couple entry 8 pm · Varmala at 10', 'after 020: sending again keeps one family line, studio lines stay');

-- running 020 again changes nothing
\ir ../supabase/020_client_note_one_line.sql
select pg_temp.check((select data ->> 'notes' from docs where id = 'e1') = E'Bring the drone\nTwo drones please\nFrom client: starts 7:30 pm · Couple entry 8 pm · Varmala at 10', '020 is safe to run twice');

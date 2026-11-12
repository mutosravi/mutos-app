-- Test for supabase/025_couple_names.sql (after pg_stub, schema and every file up to 024, then 025).
\set ON_ERROR_STOP 1
insert into members values ('c@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into client_links (wedding_key, title, emails) values ('w:bansal', 'Bansal', '{divya@gmail.com}');
insert into client_feed (wedding_key, data) values ('w:bansal', '{"functions":[{"id":"e1","name":"Ring"},{"id":"e2","name":"Haldi"}]}');
select set_config('t.tok', (select token::text from client_links), false);
set role authenticated; set request.jwt.claims = '{"email":"divya@gmail.com"}';
select pg_temp.check(not ((client_save(current_setting('t.tok')::uuid, '{"couple":{"bride":"Divya Bansal","groom":"Swastik Gupta"},"e1":{"venue":"Club Astra"}}', true)) ? 'error'), 'the family saves the couple''s names with the form');
reset role;
select pg_temp.check((select data #>> '{couple,groom}' from client_itinerary where wedding_key = 'w:bansal') = 'Swastik Gupta', 'kept in the form');
insert into crew_feed (person_key, name, data) values ('hamza', 'Hamza', '{"shoots":[{"id":"e1"}]}') on conflict (person_key) do update set data = excluded.data;
set role authenticated; set request.jwt.claims = '{"email":"c@x.com"}';
select pg_temp.check(crew_vip('e1') #>> '{couple,bride}' = 'Divya Bansal' and crew_vip('e1') #>> '{couple,groom}' = 'Swastik Gupta', 'the crew on the shoot see the couple''s names');
select pg_temp.check(crew_vip('e2') ? 'error', 'not for a shoot they are not on');
reset role;
select pg_temp.check((select location from (select data ->> 'location' as location from docs where id = 'e1') x) is null, 'the couple''s names do not touch the board (no shoot e1 there)');

-- Test for supabase/021_client_note_tidy.sql (after pg_stub, schema and all files up to 020; loads 021 itself).
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
-- the real case: copies left by the manual Apply (not logged), an old version of an edited line, a studio line
insert into docs (collection, id, data) values
  ('events', 'e1', jsonb_build_object('id','e1','name','Divya Ring','date','2026-12-01','location','Club Astra','notes',
     E'Contact to client at crown plaza adjacent to venue.\nrest of the team can reach directly the venue @ 6.15 pm max. (Club Astra)\nrest of the team can reach directly the venue @ 6.15 pm max. (Club Astra)\nrest of the team can reach directly the venue @ 6.15 pm max. (Club Astra)\nFrom client: starts 5:00 pm · old text\nrest of the team can reach directly the venue @ 6.15 pm max. (Club Astra)\nBring the drone\nBring the drone')),
  ('events', 'e2', '{"id":"e2","name":"Divya Haldi","date":"2026-12-02","notes":"Studio only\nStudio only"}'),
  ('events', 'e3', '{"id":"e3","name":"Other wedding","date":"2026-12-03","notes":"Same\nSame"}');
insert into client_links (wedding_key, title, emails) values ('w:divya', 'Divya & Swastik', '{divya@gmail.com}');
insert into client_feed (wedding_key, data) values ('w:divya', '{"functions":[{"id":"e1"},{"id":"e2"}]}');
insert into client_itinerary (wedding_key, data, submitted_at) values ('w:divya', jsonb_build_object(
  'e1', jsonb_build_object('time','17:00','contact','Divya Bansal','guests','200','notes', E'5 pm reporting time @ damson plum\nrest of the team can reach directly to the venue @ 6.15 pm max. (Club Astra)\nEVENT FLOW'),
  'e2', jsonb_build_object('venue','Home')), now());
insert into crew_feed (person_key, name, data) values ('aman', 'Aman', '{"shoots":[{"id":"e1","shoot":"Divya Ring","notes":"old"}]}');

\ir ../supabase/021_client_note_tidy.sql
select pg_temp.check((select data ->> 'notes' from docs where id = 'e1') = E'Contact to client at crown plaza adjacent to venue.\nBring the drone\nFrom client: starts 5:00 pm · contact Divya Bansal · 200 guests · 5 pm reporting time @ damson plum · rest of the team can reach directly to the venue @ 6.15 pm max. (Club Astra) · EVENT FLOW',
  'old copies and repeats gone; the studio lines stay once, in order; one fresh family line');
select pg_temp.check((select s ->> 'notes' from crew_feed, jsonb_array_elements(data -> 'shoots') s where s ->> 'id' = 'e1') like 'Contact to client%Bring the drone%From client:%', 'the crew page is cleaned too');
select pg_temp.check((select data ->> 'notes' from docs where id = 'e2') = E'Studio only\nStudio only', 'a function the family wrote no note for is left alone');
select pg_temp.check((select data ->> 'notes' from docs where id = 'e3') = E'Same\nSame', 'shoots of no family form are never touched');
select pg_temp.check((select count(*) from client_apply_log where by_email = 'cleanup-021') = 1 and (select before ->> 'notes' from client_apply_log where by_email = 'cleanup-021') like '%Club Astra)%Club Astra)%', 'the change is logged with the old notes (can be put back)');
\ir ../supabase/021_client_note_tidy.sql
select pg_temp.check((select count(*) from client_apply_log where by_email = 'cleanup-021') = 1, 'running again changes nothing');
-- a later Send also tidies
update docs set data = data || jsonb_build_object('notes', data ->> 'notes' || E'\nrest of the team can reach directly to the venue @ 6.15 pm max. (Club Astra)') where id = 'e1';
update client_itinerary set submitted_at = now() + interval '1 minute' where wedding_key = 'w:divya';
select pg_temp.check((select data ->> 'notes' from docs where id = 'e1') not like '%Club Astra)%Club Astra)%Club Astra)%' and (select data ->> 'notes' from docs where id = 'e1') like E'Contact to client%Bring the drone\nFrom client:%', 'Send after 021 keeps it clean');

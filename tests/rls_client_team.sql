-- Test for supabase/038_client_team.sql (after pg_stub, schema and all files up to 037, WITH 038).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()),('s@x.com','supervisor',null,'Sup',now()),('hamza@x.com','crew','hamza','Hamza',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into client_links (token, wedding_key, title, emails) values ('11111111-1111-1111-1111-111111111111', 'w:sharma', 'Sharma', '{fam@gmail.com}');
insert into client_feed (wedding_key, data) values ('w:sharma', jsonb_build_object(
  'functions', jsonb_build_array(
    jsonb_build_object('id','e0','name','Sharma Ring','date', to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD'),'slot','Evening'),
    jsonb_build_object('id','e1','name','Sharma Haldi','date', to_char((now() at time zone 'Asia/Kolkata')::date + 1, 'YYYY-MM-DD'),'slot','Morning'),
    jsonb_build_object('id','e2','name','Sharma Wedding','date', to_char((now() at time zone 'Asia/Kolkata')::date + 5, 'YYYY-MM-DD'),'slot','Evening'),
    jsonb_build_object('id','ep','name','Sharma Roka','date', '2020-01-01','slot','Evening')),
  'team', jsonb_build_object(
    'e0', jsonb_build_array(jsonb_build_object('name','Shrey','role','Photo','phone','98765 43210')),
    'e1', jsonb_build_array(jsonb_build_object('name','Aman','role','Video','phone','+91-90000<b>11111'), jsonb_build_object('name','Raju','role','Assistant','phone','')),
    'e2', jsonb_build_array(jsonb_build_object('name','Hamza','role','Candid','phone','9000022222')),
    'ep', jsonb_build_array(jsonb_build_object('name','Old','role','Photo','phone','9000033333')))));
set role authenticated; set request.jwt.claims = '{"email":"fam@gmail.com"}';
select set_config('t.t', client_team('11111111-1111-1111-1111-111111111111')::text, false);
select pg_temp.check((select string_agg(x ->> 'id', ',' order by x ->> 'date') from jsonb_array_elements(current_setting('t.t')::jsonb -> 'functions') x) = 'e0,e1', 'family: only today''s and tomorrow''s functions (not in 5 days, not past)');
select pg_temp.check((select t ->> 'phone' from jsonb_array_elements(current_setting('t.t')::jsonb -> 'functions') x, jsonb_array_elements(x -> 'team') t where t ->> 'name' = 'Aman') = '+919000011111'
  and (select t ->> 'phone' from jsonb_array_elements(current_setting('t.t')::jsonb -> 'functions') x, jsonb_array_elements(x -> 'team') t where t ->> 'name' = 'Shrey') = '98765 43210', 'names, roles and numbers (numbers cleaned to digits, + and spaces)');
select pg_temp.check((client_get('11111111-1111-1111-1111-111111111111')) -> 'functions' -> 0 -> 'team' is null and not (client_get('11111111-1111-1111-1111-111111111111')::text like '%9000022222%'), 'client_get never carries the team or its numbers');
do $$ begin
  begin perform 1 from client_feed; raise notice 'PASS (read checked below)'; exception when insufficient_privilege then raise notice 'PASS the family cannot read the feed table directly'; end;
end $$;
select pg_temp.check((select count(*) from client_feed) = 0, 'the family cannot read the feed table (where the later teams are)');
set request.jwt.claims = '{"email":"hamza@x.com"}';
select pg_temp.check((client_team('11111111-1111-1111-1111-111111111111')) ? 'error', 'crew cannot open a family''s team list');
set request.jwt.claims = '{"email":"s@x.com"}';
select pg_temp.check((select string_agg(x ->> 'id', ',' order by x ->> 'date') from jsonb_array_elements(client_team('11111111-1111-1111-1111-111111111111') -> 'functions') x) = 'e0,e1,e2', 'studio preview: every function from today on, to check what the family will get');
reset role;

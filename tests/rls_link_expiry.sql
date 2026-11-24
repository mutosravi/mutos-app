-- Test for supabase/046_link_expiry.sql (after pg_stub, schema and every file up to 045, then 046).
\set ON_ERROR_STOP 1
insert into members values ('o@x.com','owner',null,'Owner',now()) on conflict do nothing;
create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin if ok then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
grant execute on function pg_temp.check(boolean, text) to authenticated, anon;
insert into client_links (token, wedding_key, title, emails, deliveries_open) values ('11111111-1111-1111-1111-111111111111', 'w:sharma', 'Sharma', '{fam@gmail.com}', true);
set role authenticated; set request.jwt.claims = '{"email":"o@x.com"}';
insert into client_deliveries (wedding_key, title, status, link, expires_on, sort) values
  ('w:sharma', 'Raw JPGs', 'delivered', 'https://drive.google.com/raw', (now() at time zone 'Asia/Kolkata')::date - 1, 0),
  ('w:sharma', 'Edited photos', 'delivered', 'https://drive.google.com/edit', (now() at time zone 'Asia/Kolkata')::date, 1),
  ('w:sharma', 'Film', 'delivered', 'https://drive.google.com/film', null, 2);
select pg_temp.check((client_after('11111111-1111-1111-1111-111111111111') -> 'deliveries' -> 0 ->> 'link') is not null, 'the studio still sees an expired link');
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select set_config('t.a', client_after('11111111-1111-1111-1111-111111111111')::text, false);
select pg_temp.check((current_setting('t.a')::jsonb -> 'deliveries' -> 0 ->> 'link') is null and (current_setting('t.a')::jsonb -> 'deliveries' -> 0 ->> 'expired')::boolean
  and (current_setting('t.a')::jsonb -> 'deliveries' -> 0 ->> 'has_link')::boolean, 'family: yesterday''s link is gone, marked expired');
select pg_temp.check((current_setting('t.a')::jsonb -> 'deliveries' -> 1 ->> 'link') is not null and not (current_setting('t.a')::jsonb -> 'deliveries' -> 1 ->> 'expired')::boolean
  and current_setting('t.a')::jsonb -> 'deliveries' -> 1 ->> 'expires_on' is not null, 'family: a link ending today still opens today, with its date');
select pg_temp.check((current_setting('t.a')::jsonb -> 'deliveries' -> 2 ->> 'link') is not null and current_setting('t.a')::jsonb -> 'deliveries' -> 2 -> 'expires_on' = 'null'::jsonb, 'family: no date = no limit');
set request.jwt.claims = '{"email":"o@x.com"}';
update client_deliveries set expires_on = (now() at time zone 'Asia/Kolkata')::date + 30 where title = 'Raw JPGs';
set request.jwt.claims = '{"email":"fam@gmail.com"}';
select pg_temp.check((client_after('11111111-1111-1111-1111-111111111111') -> 'deliveries' -> 0 ->> 'link') is not null, 'more days given: the family can download again');
reset role;

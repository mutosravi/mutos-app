create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth, public to anon, authenticated;
create publication supabase_realtime;
create schema if not exists extensions; grant usage on schema extensions to anon, authenticated;

-- Muto's app · Undo a check-in / check-out tapped by mistake (11 Nov 2026, Ravi). Run once, after 012_supervisor.sql.
-- An employee can take back their own LAST tap of today for 10 minutes. After that, or for an older day, they ask for a
-- correction (My Requests) and the owner approves it. Every undo is written to the attendance log.
create or replace function public.att_undo() returns jsonb
  language plpgsql security definer set search_path = public as $$
declare p public.att_punch;
begin
  if public.my_email() = '' then return jsonb_build_object('error', 'Sign in first.'); end if;
  select * into p from public.att_punch where email = public.my_email() and day = public.today_ist() order by at desc, id desc limit 1;
  if not found then return jsonb_build_object('error', 'Nothing to undo today.'); end if;
  if p.by_fix then return jsonb_build_object('error', 'That time was set by an approved correction. Ask Ravi to change it.'); end if;
  if p.at < now() - interval '10 minutes' then return jsonb_build_object('error', 'That was more than 10 minutes ago. Ask for a correction in My Requests.'); end if;
  delete from public.att_punch where id = p.id;
  insert into public.att_log (by_email, what) values (public.my_email(),
    'Undid a mistaken ' || case p.kind when 'in' then 'check-in' when 'out' then 'check-out' when 'lunch_out' then 'lunch break' else 'back from lunch' end
    || ' tapped at ' || to_char(p.at at time zone 'Asia/Kolkata', 'HH12:MI am'));
  return jsonb_build_object('ok', true, 'kind', p.kind);
end $$;
revoke all on function public.att_undo() from public, anon;
grant execute on function public.att_undo() to authenticated;

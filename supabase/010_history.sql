-- Muto's app · salary and attendance history from before the app (6 Nov 2026). Run after 009_bookings.sql.
-- One row per person per month, copied as it was in the "Salary Muto's 2026" sheet (Mar–Oct 2026): salary, days,
-- presents, half days, leave, lates, overtime, net pay, payment status and note. Nothing is recalculated:
-- months from November on are worked out by the app from check-ins.
create table if not exists public.salary_history (
  person      uuid not null references public.people(id) on delete cascade,
  month       text not null check (month ~ '^\d{4}-\d{2}$'),
  data        jsonb not null check (jsonb_typeof(data) = 'object'),
  source      text not null default 'Salary sheet',
  imported_at timestamptz not null default now(),
  primary key (person, month)
);
alter table public.salary_history enable row level security;
drop policy if exists sh_select on public.salary_history;
create policy sh_select on public.salary_history for select to authenticated using (public.is_payroll() or person = public.my_person());
drop policy if exists sh_write on public.salary_history;
create policy sh_write on public.salary_history for all to authenticated using (public.is_owner()) with check (public.is_owner());
revoke all on public.salary_history from anon, authenticated;
grant select, insert, update, delete on public.salary_history to authenticated;

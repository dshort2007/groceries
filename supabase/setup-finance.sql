-- One-time database setup for the family finance app.
-- Paste into the Supabase SQL Editor and Run.
-- BEFORE running: put your two sign-in emails in the last statement.

-- Who is in the family. Only logins listed here can see or change anything.
create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.members enable row level security;
create policy "See only your own membership"
  on public.members for select to authenticated
  using ((select auth.uid()) = user_id);
grant select on public.members to authenticated;

-- Everything the app stores: one row per envelope, transaction, debt, etc.
-- "kind" says what the row is, "data" holds its details.
create table public.records (
  id uuid primary key,
  kind text not null,
  data jsonb not null default '{}',
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index records_updated_at on public.records (updated_at);

alter table public.records enable row level security;
create policy "Family members only"
  on public.records for all to authenticated
  using (exists (select 1 from public.members where user_id = (select auth.uid())))
  with check (exists (select 1 from public.members where user_id = (select auth.uid())));
grant select, insert, update on public.records to authenticated;

-- Stamp every change with the server's clock and who made it, so devices
-- can ask "what changed since I last looked?" without trusting phone clocks.
create function public.touch_record() returns trigger
  language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger records_touch
  before insert or update on public.records
  for each row execute function public.touch_record();

-- Add the family's logins. Replace both emails, keeping the quotes.
insert into public.members (user_id)
  select id from auth.users
  where email in ('you@example.com', 'spouse@example.com');

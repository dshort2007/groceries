-- One-time database setup. Paste this into the Supabase SQL Editor and Run.

-- One row per login, holding that household's list, stores and prices.
create table public.households (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Lock the table down, then allow each signed-in login to see and change
-- only its own row. Without this, anyone with the app's address could read it.
alter table public.households enable row level security;

create policy "Each login reads and writes only its own row"
  on public.households
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

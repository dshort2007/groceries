-- One-time database setup for automatic bank connections (Plaid).
-- Paste into the Supabase SQL Editor and Run. Needs setup-finance.sql first.

-- One row per connected bank login. The access_token is the key that lets
-- Plaid read that bank's transactions, so this table is locked: row level
-- security is on with no rules, which means no browser can read or change
-- it, signed in or not. Only the server-side function can.
create table public.plaid_items (
  item_id text primary key,
  access_token text not null,
  institution text,
  accounts jsonb not null default '[]',
  cursor text,
  start_date date not null,
  last_sync timestamptz,
  error text,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.plaid_items enable row level security;
revoke all on public.plaid_items from anon, authenticated;

-- Let the server-side function do its job: keep its own table, check who
-- is in the family, and add bank transactions to the app's records.
grant select, insert, update, delete on public.plaid_items to service_role;
grant select on public.members to service_role;
grant select, insert, update on public.records to service_role;

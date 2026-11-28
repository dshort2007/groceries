-- One-time database setup for notifications.
-- Paste into the Supabase SQL Editor and Run. Needs setup-finance.sql and
-- setup-plaid.sql first, and the "notify" function deployed.

-- Where the notification keys are kept. Like the bank table, it's locked:
-- no browser can read it, signed in or not. Only the server-side function
-- can. The keys themselves are created by the function the first time it
-- runs, so there is nothing to copy or paste.
create table public.push_config (
  id int primary key default 1 check (id = 1),
  cron_key text not null default gen_random_uuid()::text,
  public_key text,
  private_key text
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;
grant select, update on public.push_config to service_role;
insert into public.push_config (id) values (1);

-- The function removes devices that have gone away, and reads the records.
grant select, insert, update on public.records to service_role;
grant select on public.members to service_role;

-- A timer inside the database. At the top of every hour it asks the
-- "notify" function to check the bank and send anything worth telling:
-- alerts as things happen, and the summary once each morning. It proves
-- it's the timer by sending the key stored above.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'family-budget-notify',
  '0 * * * *',
  $job$
  select net.http_post(
    url := 'https://iaqusemsdmlrqrenqbyw.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_QthGB9tWFXOpGqzFoqKp0A_FICXMTRm',
      'x-notify-key', (select cron_key from public.push_config where id = 1)
    ),
    body := '{"action":"tick"}'::jsonb
  );
  $job$
);

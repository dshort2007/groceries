-- Switches notifications from once a day to every hour, for alerts as
-- things happen. Only needed if you ran setup-notify.sql before this
-- existed. Paste into the Supabase SQL Editor and Run.

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

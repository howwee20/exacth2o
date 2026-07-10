create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create or replace function public.invoke_owner_health_sync()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, vault, net
as $$
declare
  cron_secret text;
  request_id bigint;
begin
  select decrypted_secret
  into cron_secret
  from vault.decrypted_secrets
  where name = 'exacth2o_owner_health_cron_secret'
  limit 1;

  if char_length(coalesce(cron_secret, '')) < 32 then
    raise exception 'Owner-health Cron secret is missing or too short';
  end if;

  select net.http_post(
    url := 'https://zmhdclcjrkntrpynozvo.supabase.co/functions/v1/sync-owner-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-owner-health-secret', cron_secret
    ),
    body := jsonb_build_object('source', 'supabase_cron_watchdog'),
    timeout_milliseconds := 25000
  )
  into request_id;

  return request_id;
end;
$$;

revoke all on function public.invoke_owner_health_sync() from public, anon, authenticated;
grant execute on function public.invoke_owner_health_sync() to service_role;

comment on function public.invoke_owner_health_sync()
  is 'Queues the server-authorized owner-health Edge Function through pg_net. The encrypted Cron secret must be provisioned separately in Vault.';

select cron.unschedule(jobid)
from cron.job
where jobname = 'exacth2o-owner-health-sync';

select cron.schedule(
  'exacth2o-owner-health-sync',
  '*/5 * * * *',
  'select public.invoke_owner_health_sync();'
);

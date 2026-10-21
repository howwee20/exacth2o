-- Supabase Cron starts an Edge invocation only when the function has work.
--
-- Every 5 minutes Cron called sync-owner-health and assistant-automation-runner
-- (576 billed invocations a day). With the control executor ingesting every
-- 2 minutes, sync-owner-health answered nearly all Cron calls with 202
-- "primary_authority_fresh", and no assistant schedule or monitor exists yet.
-- Each gate below repeats that function's own skip rule in SQL, so a skipped
-- call is one the function would have done nothing with. Any gate error
-- falls through to the previous unconditional call: the watchdog never goes
-- quiet because of this check. No secret, schedule, payload or URL changes.
set lock_timeout = '2s';
set statement_timeout = '30s';

create or replace function public.owner_health_watchdog_due()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  latest record;
  runtime record;
  history_recovered_at timestamptz;
begin
  -- Mirrors sync-owner-health's external-watchdog skip: a complete, healthy
  -- snapshot and runtime row under 3 minutes old, observations under 10
  -- minutes old, state still fresh, and no 30-minute history recovery due.
  select snapshot.project_id, snapshot.device_id, snapshot.created_at, snapshot.captured_at,
         snapshot.status_endpoint_ok, snapshot.ingest_complete
  into latest
  from public.device_health_snapshots snapshot
  order by snapshot.captured_at desc
  limit 1;
  if not found then return true; end if;

  select state.updated_at, state.state_observed_at, state.state_fresh_until
  into runtime
  from public.device_runtime_state state
  where state.project_id = latest.project_id
    and state.device_id = latest.device_id;
  if not found then return true; end if;

  select maintenance.last_completed_at
  into history_recovered_at
  from public.device_maintenance_state maintenance
  where maintenance.task_name = 'owner_health_history_recovery';

  return not (
    latest.status_endpoint_ok is true
    and latest.ingest_complete is true
    and latest.created_at > now() - interval '3 minutes'
    and runtime.updated_at > now() - interval '3 minutes'
    and latest.captured_at > now() - interval '10 minutes'
    and runtime.state_observed_at > now() - interval '10 minutes'
    and runtime.state_fresh_until > now()
    and history_recovered_at > now() - interval '30 minutes'
  );
end;
$$;

create or replace function public.assistant_automation_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Mirrors assistant-automation-runner: a claimable schedule, or an active
  -- monitor whose max(5, check_every_minutes ?? 10) minute interval has passed.
  select exists (
      select 1 from public.assistant_schedules schedule
      where schedule.status = 'active'
        and schedule.next_run_at is not null
        and schedule.next_run_at <= now()
        and (schedule.lease_until is null or schedule.lease_until <= now())
    ) or exists (
      select 1 from public.assistant_monitors monitor
      where monitor.status = 'active'
        and (monitor.last_evaluated_at is null
             or monitor.last_evaluated_at <= now()
               - make_interval(mins => greatest(5, coalesce(monitor.check_every_minutes, 10))))
    );
$$;

revoke all on function public.owner_health_watchdog_due() from public, anon, authenticated;
revoke all on function public.assistant_automation_due() from public, anon, authenticated;

create or replace function public.invoke_owner_health_sync()
 returns bigint
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'vault', 'net'
as $function$
declare
  cron_secret text;
  request_id bigint;
begin
  begin
    if not public.owner_health_watchdog_due() then
      return null;
    end if;
  exception when others then
    -- Fall through: an unanswerable gate must not silence the watchdog.
    null;
  end;

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
$function$;

create or replace function public.invoke_assistant_automation_runner()
 returns bigint
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'vault', 'net'
as $function$
declare
  cron_secret text;
  request_id bigint;
begin
  begin
    if not public.assistant_automation_due() then
      return null;
    end if;
  exception when others then
    null;
  end;

  select decrypted_secret
  into cron_secret
  from vault.decrypted_secrets
  where name = 'exacth2o_owner_health_cron_secret'
  limit 1;

  if char_length(coalesce(cron_secret, '')) < 32 then
    raise exception 'Assistant automation Cron secret is unavailable';
  end if;

  select net.http_post(
    url := 'https://zmhdclcjrkntrpynozvo.supabase.co/functions/v1/assistant-automation-runner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-assistant-automation-secret', cron_secret
    ),
    body := jsonb_build_object('source', 'supabase_cron'),
    timeout_milliseconds := 25000
  )
  into request_id;

  return request_id;
end;
$function$;

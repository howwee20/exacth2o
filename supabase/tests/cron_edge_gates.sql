-- Transaction-only fixtures for the Cron Edge gates. Nothing is sent: every
-- probe either returns before net.http_post or is rolled back.
begin;
do $$
declare
  project constant uuid := '22222222-2222-4222-8222-222222222222';
  device constant text := '3100e37ee3205651fe3dd86dafd4dc0c';
  queued_before bigint;
  result bigint;
  monitor_id uuid;
begin
  delete from public.device_health_snapshots;
  delete from public.device_runtime_state;
  delete from public.device_maintenance_state where task_name = 'owner_health_history_recovery';
  delete from public.assistant_schedules;
  delete from public.assistant_monitors;

  if not public.owner_health_watchdog_due() then
    raise exception 'An empty health history must keep the watchdog due';
  end if;

  insert into public.device_health_snapshots(project_id, device_id, device_name, source, captured_at, owner_checked_at,
      status_endpoint_ok, history_endpoint_ok, overall_status, ingest_complete, created_at)
    values (project, device, 'gate test', 'control_executor_watchdog', now() - interval '30 seconds',
      now() - interval '30 seconds', true, true, 'OK', true, now() - interval '25 seconds');
  insert into public.device_runtime_state(project_id, device_id, device_name, updated_at, state_observed_at, state_fresh_until)
    values (project, device, 'gate test', now() - interval '20 seconds', now() - interval '30 seconds', now() + interval '9 minutes')
    on conflict (project_id, device_id) do update
      set updated_at = excluded.updated_at, state_observed_at = excluded.state_observed_at,
          state_fresh_until = excluded.state_fresh_until;
  insert into public.device_maintenance_state(task_name, last_completed_at)
    values ('owner_health_history_recovery', now() - interval '10 minutes')
    on conflict (task_name) do update set last_completed_at = excluded.last_completed_at;

  if public.owner_health_watchdog_due() then
    raise exception 'A fresh primary ingest must skip the Cron call';
  end if;
  select count(*) into queued_before from net.http_request_queue;
  result := public.invoke_owner_health_sync();
  if result is not null or (select count(*) from net.http_request_queue) <> queued_before then
    raise exception 'A skipped watchdog still queued an HTTP request';
  end if;

  -- Each stale signal on its own makes the watchdog due again.
  update public.device_maintenance_state set last_completed_at = now() - interval '31 minutes'
    where task_name = 'owner_health_history_recovery';
  if not public.owner_health_watchdog_due() then raise exception 'Due history recovery was skipped'; end if;
  update public.device_maintenance_state set last_completed_at = now() where task_name = 'owner_health_history_recovery';
  update public.device_runtime_state set state_fresh_until = now() - interval '1 second' where device_id = device;
  if not public.owner_health_watchdog_due() then raise exception 'Expired runtime state was skipped'; end if;
  update public.device_runtime_state set state_fresh_until = now() + interval '9 minutes',
    updated_at = now() - interval '4 minutes' where device_id = device;
  if not public.owner_health_watchdog_due() then raise exception 'A stale runtime row was skipped'; end if;
  update public.device_runtime_state set updated_at = now() where device_id = device;
  update public.device_health_snapshots set ingest_complete = false where device_id = device;
  if not public.owner_health_watchdog_due() then raise exception 'An incomplete ingest was skipped'; end if;

  -- When due, the invoker proceeds past the gate to its unchanged secret check.
  begin
    perform public.invoke_owner_health_sync();
    if not exists (select 1 from vault.decrypted_secrets where name = 'exacth2o_owner_health_cron_secret') then
      raise exception 'Invoker skipped a due watchdog';
    end if;
  exception when raise_exception then
    if sqlerrm not like 'Owner-health Cron secret is missing%' then raise; end if;
  end;

  -- Automation: nothing configured means nothing to run.
  if public.assistant_automation_due() then raise exception 'No monitors or schedules must skip the runner'; end if;
  select count(*) into queued_before from net.http_request_queue;
  if public.invoke_assistant_automation_runner() is not null
     or (select count(*) from net.http_request_queue) <> queued_before then
    raise exception 'A skipped automation run still queued an HTTP request';
  end if;

  -- A monitor is due exactly when the runner would evaluate it.
  insert into auth.users(id, email) values ('7b7b7b7b-0000-4000-8000-00000000c0de', 'gate-monitor@example.invalid');
  insert into public.assistant_monitors(project_id, created_by, name, metric, comparator, window_minutes,
      check_every_minutes, cooldown_minutes, review_token_hash, status, last_evaluated_at, confirmed_at)
    values ('44444444-4444-4444-8444-444444444441', '7b7b7b7b-0000-4000-8000-00000000c0de', 'gate test',
      'sensor_stale', 'stale', 60, 10, 30, repeat('a', 64), 'active', now() - interval '2 minutes', now())
    returning id into monitor_id;
  if public.assistant_automation_due() then raise exception 'A monitor evaluated 2 minutes ago is not due'; end if;
  update public.assistant_monitors set last_evaluated_at = now() - interval '10 minutes 1 second' where id = monitor_id;
  if not public.assistant_automation_due() then raise exception 'A monitor past its interval was skipped'; end if;
  update public.assistant_monitors set last_evaluated_at = null where id = monitor_id;
  if not public.assistant_automation_due() then raise exception 'A never-evaluated monitor was skipped'; end if;
  update public.assistant_monitors set status = 'paused' where id = monitor_id;
  if public.assistant_automation_due() then raise exception 'A paused monitor made the runner due'; end if;
end;
$$;
rollback;

-- Rollback for 20261021043151_agent_wake_and_attention.sql,
-- 20261021043212_gate_cron_edge_invocations.sql and
-- 20261021043233_edge_usage_monitor.sql.
--
-- Order matters: first redeploy the previous gas-mixer-agent,
-- gas-mixer-native-agent and lighting-native-agent Edge Functions (they read
-- agent_attention_until), then run this file. It restores the exact function
-- definitions read from production on 2026-10-21 before the change, removes
-- the wake triggers, gates and index, and drops the attention columns (they
-- only ever held "someone is waiting" timestamps). No command, state,
-- reading, experiment or controller row is changed.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Usage monitor: stop the hourly job, then remove its functions and the
-- table of hourly estimates (derived data, recomputable from counters).
select cron.unschedule(jobid) from cron.job where jobname = 'exacth2o-edge-usage-observation';
drop function if exists public.edge_usage_budget();
drop function if exists public.record_edge_usage_observation();
drop function if exists public.edge_usage_counters();
drop table if exists public.edge_usage_observations;

drop trigger if exists agent_wake_native_command on public.gas_mixer_native_commands;
drop trigger if exists agent_wake_lighting_command on public.lighting_commands;
drop trigger if exists agent_wake_screen_command on public.gas_mixer_remote_commands;
drop trigger if exists agent_wake_screen_session on public.gas_mixer_remote_sessions;
drop function if exists public.agent_wake_on_native_command();
drop function if exists public.agent_wake_on_lighting_command();
drop function if exists public.agent_wake_on_screen_activity();
drop index if exists public.gas_mixer_remote_sessions_active_idx;

CREATE OR REPLACE FUNCTION public.gas_mixer_native_status(requested_project_id uuid, requested_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  expected_project_id constant uuid :=
    '44444444-4444-4444-8444-444444444441'::uuid;
  expected_device_id constant text := 'gas-mixer:b827eb548a44';
  native_state public.gas_mixer_native_device_state%rowtype;
  latest_command public.gas_mixer_native_commands%rowtype;
begin
  if requested_project_id <> expected_project_id
     or requested_device_id <> expected_device_id
     or not public.has_gas_mixer_native_access(
       requested_project_id,
       requested_device_id,
       'remote_view'
     ) then
    raise exception 'Gas mixer access is required'
      using errcode = '42501';
  end if;

  select *
  into native_state
  from public.gas_mixer_native_device_state
  where project_id = requested_project_id
    and device_id = requested_device_id;

  select *
  into latest_command
  from public.gas_mixer_native_commands
  where project_id = requested_project_id
    and device_id = requested_device_id
    and requested_by = auth.uid()
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'project_id', requested_project_id,
    'device_id', requested_device_id,
    'bridge_ready', coalesce(
      native_state.bridge_connected
      and native_state.bridge_ready
      and native_state.last_bridge_at >= now() - interval '45 seconds',
      false
    ),
    'bridge_version', native_state.bridge_version,
    'last_bridge_at', native_state.last_bridge_at,
    'state_revision', coalesce(native_state.state_revision, 0),
    'requested_state', native_state.requested_state,
    'applied_state', native_state.applied_state,
    'observed_state', native_state.observed_state,
    'remote_control_allowed', public.has_gas_mixer_native_access(
      requested_project_id,
      requested_device_id,
      'remote_control'
    ),
    'last_command', case
      when latest_command.id is null then null
      else jsonb_build_object(
        'id', latest_command.id,
        'field', latest_command.payload ->> 'field',
        'status', latest_command.status,
        'created_at', latest_command.created_at,
        'completed_at', latest_command.completed_at,
        'error_message', latest_command.error_message
      )
    end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.lighting_native_status(requested_project_id uuid, requested_device_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  expected_project_id constant uuid :=
    '44444444-4444-4444-8444-444444444441'::uuid;
  expected_device_id constant text := 'lighting:beagle';
  lighting_state public.lighting_device_state%rowtype;
  latest_command public.lighting_commands%rowtype;
begin
  if requested_project_id <> expected_project_id
     or requested_device_id <> expected_device_id
     or not public.has_gas_mixer_module_access(
       requested_project_id,
       requested_device_id,
       'remote_view'
     ) then
    raise exception 'Gas mixer installation access is required'
      using errcode = '42501';
  end if;

  select *
  into lighting_state
  from public.lighting_device_state
  where project_id = requested_project_id
    and device_id = requested_device_id;

  select *
  into latest_command
  from public.lighting_commands
  where project_id = requested_project_id
    and device_id = requested_device_id
    and requested_by = auth.uid()
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'project_id', requested_project_id,
    'device_id', requested_device_id,
    'bridge_ready', coalesce(
      lighting_state.bridge_connected
      and lighting_state.bridge_ready
      and lighting_state.last_bridge_at >= now() - interval '15 seconds',
      false
    ),
    'bridge_version', lighting_state.bridge_version,
    'last_bridge_at', lighting_state.last_bridge_at,
    'state_revision', coalesce(lighting_state.state_revision, 0),
    'requested_intensity', lighting_state.requested_intensity,
    'controller_intensity', lighting_state.controller_intensity,
    'last_nonzero_intensity', lighting_state.last_nonzero_intensity,
    'last_source', lighting_state.last_source,
    'hardware_verification', lighting_state.hardware_verification,
    'controller_process_started_at', lighting_state.controller_process_started_at,
    'remote_control_allowed', public.has_gas_mixer_module_access(
      requested_project_id,
      requested_device_id,
      'remote_control'
    ),
    'last_command', case
      when latest_command.id is null then null
      else jsonb_build_object(
        'id', latest_command.id,
        'intensity', latest_command.intensity,
        'status', latest_command.status,
        'created_at', latest_command.created_at,
        'completed_at', latest_command.completed_at,
        'controller_intensity', latest_command.controller_intensity,
        'error_message', latest_command.error_message
      )
    end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.invoke_owner_health_sync()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault', 'net'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.invoke_assistant_automation_runner()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault', 'net'
AS $function$
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

drop function if exists public.owner_health_watchdog_due();
drop function if exists public.assistant_automation_due();

alter table public.gas_mixer_native_device_state drop column if exists agent_attention_until;
alter table public.lighting_device_state drop column if exists agent_attention_until;
alter table public.gas_mixer_device_status drop column if exists agent_attention_until;

notify pgrst, 'reload schema';

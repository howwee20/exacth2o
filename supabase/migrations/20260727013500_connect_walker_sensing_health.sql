-- Connect the Walker sensing-only observer to the system-admin health summary.
-- This read-side migration does not create controller, command, pairing,
-- target, schedule, calibration, board, valve, or watering authority.

update public.project_platform_config
set
  capability_contract_version =
    '2026-07-27.walker-sensing-observer-v1',
  display_config = coalesce(display_config, '{}'::jsonb) ||
    jsonb_build_object(
      'live_ingestion_status', 'sensing_observer',
      'health_summary_connected', true,
      'sensor_scan_interval_seconds', 600,
      'controller_required_state', 'STOPPED'
    ),
  updated_at = now()
where project_id = '33333333-3333-4333-8333-333333333331'::uuid;

create or replace function public.walker_live_observation_status(
  requested_project_id uuid default
    '33333333-3333-4333-8333-333333333331'::uuid,
  requested_device_id text default
    'balena:a1c4ace2b367fbee8521f1aff6a6329b'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  latest_live_reading_at timestamptz;
  latest_source_created_at timestamptz;
  evidenced_sensor_count integer;
  current_sensor_count integer;
  stale_sensor_count integer;
  device_name text;
  state public.walker_live_ingest_state%rowtype;
  freshness text;
  overall_status text;
begin
  if requested_project_id <>
       '33333333-3333-4333-8333-333333333331'::uuid
     or requested_device_id <>
       'balena:a1c4ace2b367fbee8521f1aff6a6329b' then
    raise exception 'Walker live observation scope does not match this installation';
  end if;
  if not public.has_system_admin_installation_access(
    requested_project_id,
    requested_device_id,
    'observe'
  ) then
    raise exception 'Walker system administrator observation access required'
      using errcode = '42501';
  end if;

  select name into device_name
  from public.devices
  where project_id = requested_project_id
    and id = requested_device_id;

  select count(*)::integer
  into evidenced_sensor_count
  from public.walker_observation_sensor_metadata
  where project_id = requested_project_id
    and device_id = requested_device_id;

  select
    max(device_recorded_at),
    max(source_created_at),
    count(distinct source_sensor_id) filter (
      where source_created_at >= now() - interval '15 minutes'
    )::integer
  into
    latest_live_reading_at,
    latest_source_created_at,
    current_sensor_count
  from public.walker_live_telemetry_readings
  where project_id = requested_project_id
    and device_id = requested_device_id;

  current_sensor_count := coalesce(current_sensor_count, 0);
  stale_sensor_count := greatest(evidenced_sensor_count - current_sensor_count, 0);

  select * into state
  from public.walker_live_ingest_state
  where project_id = requested_project_id
    and device_id = requested_device_id;

  freshness := case
    when latest_source_created_at is null then 'awaiting_publisher'
    when latest_source_created_at >= now() - interval '15 minutes' then 'live'
    when latest_source_created_at >= now() - interval '1 hour' then 'delayed'
    else 'stale'
  end;

  overall_status := case
    when freshness = 'live' and current_sensor_count = evidenced_sensor_count
      then 'operational'
    when freshness = 'live' then 'scanning'
    when freshness = 'delayed' then 'delayed'
    when freshness = 'stale' then 'stale'
    when state.status = 'healthy' then 'scanning'
    else 'offline'
  end;

  return jsonb_build_object(
    'project_id', requested_project_id,
    'device_id', requested_device_id,
    'device_name', device_name,
    'observation_only', true,
    'portal_control_available', false,
    'expected_sensor_count', 100,
    'evidenced_sensor_count', evidenced_sensor_count,
    'current_sensor_count', current_sensor_count,
    'stale_sensor_count', stale_sensor_count,
    'missing_numeric_positions', jsonb_build_array(48, 50, 51, 100),
    'window_hours', 72,
    'freshness', freshness,
    'overall_status', overall_status,
    'latest_live_reading_at', latest_live_reading_at,
    'publisher', jsonb_build_object(
      'status', state.status,
      'cursor', state.source_cursor,
      'source_latest_known', state.source_latest_known,
      'accepted_after', state.accepted_after,
      'last_success_at', state.last_success_at,
      'last_attempt_at', state.last_attempt_at,
      'last_error', state.last_error
    )
  );
end;
$$;

revoke all on function public.walker_live_observation_status(uuid, text)
  from public, anon;
grant execute on function public.walker_live_observation_status(uuid, text)
  to authenticated, service_role;

comment on function public.walker_live_observation_status(uuid, text) is
  'System-admin-only Walker sensing freshness and current-sensor health summary.';

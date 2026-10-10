-- Read-path optimization only. No telemetry, control or authorization scope changes.

CREATE OR REPLACE FUNCTION public.walker_live_observation_status(requested_project_id uuid DEFAULT '33333333-3333-4333-8333-333333333331'::uuid, requested_device_id text DEFAULT 'balena:a1c4ace2b367fbee8521f1aff6a6329b'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- Each maximum uses the matching existing time index. The current count
  -- scans only the freshness window instead of sorting the entire archive.
  select device_recorded_at into latest_live_reading_at
  from public.walker_live_telemetry_readings
  where project_id = requested_project_id
    and device_id = requested_device_id
    and device_recorded_at is not null
  order by device_recorded_at desc
  limit 1;

  select source_created_at into latest_source_created_at
  from public.walker_live_telemetry_readings
  where project_id = requested_project_id
    and device_id = requested_device_id
    and source_created_at is not null
  order by source_created_at desc
  limit 1;

  select count(distinct source_sensor_id)::integer into current_sensor_count
  from public.walker_live_telemetry_readings
  where project_id = requested_project_id
    and device_id = requested_device_id
    and source_created_at >= now() - interval '15 minutes';

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
$function$;


-- Cache the request identity once per statement while retaining the same policy predicates.
alter policy "users read own profile" on public.profiles
  using (id = (select auth.uid()));
alter policy "members read own memberships" on public.project_members
  using (user_id = (select auth.uid()));
alter policy "Users can read software terms acceptances" on public.software_terms_acceptances
  using (user_id = (select auth.uid()) or public.is_portal_admin(project_id));
alter policy "Portal admins can add support notes" on public.support_notes
  with check (public.is_portal_admin(project_id) and author_user_id = (select auth.uid()));

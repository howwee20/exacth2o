-- Read-only product views; no controller configuration or access grants are changed.
create or replace function public.portal_team_snapshot(requested_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.portal_access pa where pa.project_id = requested_project_id
      and pa.user_id = auth.uid() and pa.role = 'admin' and pa.access_scope = 'project'
  ) then
    raise exception 'Project administrator access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('email', pa.email, 'role', pa.role, 'access_scope', pa.access_scope) order by pa.email)
      from public.portal_access pa where pa.project_id = requested_project_id), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('email', invite.email, 'role', invite.role, 'expires_at', invite.expires_at, 'accepted_at', invite.accepted_at) order by invite.created_at desc)
      from (select email, role, expires_at, accepted_at, created_at from public.project_invites where project_id = requested_project_id order by created_at desc limit 100) invite), '[]'::jsonb)
  );
end; $$;
revoke all on function public.portal_team_snapshot(uuid) from public, anon;
grant execute on function public.portal_team_snapshot(uuid) to authenticated;

create or replace function public.walker_latest_recorded_snapshot(
  requested_project_id uuid default
    '33333333-3333-4333-8333-333333333331'::uuid,
  requested_device_id text default
    'balena:a1c4ace2b367fbee8521f1aff6a6329b',
  requested_window_hours integer default 72,
  requested_point_budget integer default 288
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  bounded_window_hours integer;
  bounded_point_budget integer;
  range_start timestamptz;
  range_end timestamptz;
  bucket_seconds bigint;
  status_payload jsonb;
  sensors_payload jsonb;
  series_payload jsonb;
begin
  if not public.has_system_admin_installation_access(
    requested_project_id,
    requested_device_id,
    'observe'
  ) then
    raise exception 'Walker system administrator observation access required'
      using errcode = '42501';
  end if;
  if requested_project_id <>
       '33333333-3333-4333-8333-333333333331'::uuid
     or requested_device_id <>
       'balena:a1c4ace2b367fbee8521f1aff6a6329b' then
    raise exception 'Walker live observation scope does not match this installation';
  end if;

  bounded_window_hours := greatest(1, least(coalesce(requested_window_hours, 72), 168));
  bounded_point_budget := greatest(72, least(coalesce(requested_point_budget, 288), 576));
  select coalesce(max(reading.device_recorded_at), now()) into range_end
  from public.walker_live_telemetry_readings reading
  where reading.project_id = requested_project_id and reading.device_id = requested_device_id
    and reading.device_recorded_at <= now();
  range_start := range_end - make_interval(hours => bounded_window_hours);
  bucket_seconds := greatest(
    60,
    ceil(
      extract(epoch from (range_end - range_start)) /
      bounded_point_budget::numeric /
      60
    )::bigint * 60
  );
  status_payload := public.walker_live_observation_status(
    requested_project_id,
    requested_device_id
  );

  with latest as (
    select distinct on (reading.source_sensor_id)
      reading.source_sensor_id,
      reading.calibrated_value,
      reading.device_recorded_at
    from public.walker_live_telemetry_readings reading
    where reading.project_id = requested_project_id
      and reading.device_id = requested_device_id
      and reading.device_recorded_at >= range_start
      and reading.device_recorded_at <= range_end
    order by
      reading.source_sensor_id,
      reading.device_recorded_at desc,
      reading.source_reading_id desc
  ),
  counts as (
    select
      reading.source_sensor_id,
      count(*)::integer as live_point_count
    from public.walker_live_telemetry_readings reading
    where reading.project_id = requested_project_id
      and reading.device_id = requested_device_id
      and reading.device_recorded_at >= range_start
      and reading.device_recorded_at <= range_end
    group by reading.source_sensor_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'source_sensor_id', metadata.source_sensor_id,
      'sensor_key', metadata.sensor_key,
      'display_label', metadata.display_label,
      'source_pairing_name', metadata.source_pairing_name,
      'position_number', metadata.position_number,
      'board_serial_id', metadata.board_serial_id,
      'sensor_address', metadata.sensor_address,
      'latest_calibrated_value', latest.calibrated_value,
      'latest_reading_at', latest.device_recorded_at,
      'live_point_count', coalesce(counts.live_point_count, 0)
    )
    order by metadata.position_number nulls last, metadata.source_sensor_id
  ), '[]'::jsonb)
  into sensors_payload
  from public.walker_observation_sensor_metadata metadata
  left join latest on latest.source_sensor_id = metadata.source_sensor_id
  left join counts on counts.source_sensor_id = metadata.source_sensor_id
  where metadata.project_id = requested_project_id
    and metadata.device_id = requested_device_id;

  with bucketed as (
    select
      reading.source_sensor_id,
      to_timestamp(
        floor(extract(epoch from reading.device_recorded_at) / bucket_seconds) *
        bucket_seconds
      ) as point_at,
      min(reading.calibrated_value) as minimum_value,
      max(reading.calibrated_value) as maximum_value,
      avg(reading.calibrated_value) as average_value,
      count(*)::integer as sample_count
    from public.walker_live_telemetry_readings reading
    where reading.project_id = requested_project_id
      and reading.device_id = requested_device_id
      and reading.device_recorded_at >= range_start
      and reading.device_recorded_at <= range_end
    group by reading.source_sensor_id, point_at
  ),
  series_rows as (
    select
      metadata.source_sensor_id,
      metadata.display_label,
      metadata.source_pairing_name,
      metadata.position_number,
      metadata.board_serial_id,
      coalesce(jsonb_agg(
        jsonb_build_object(
          'at', bucketed.point_at,
          'minimum', bucketed.minimum_value,
          'maximum', bucketed.maximum_value,
          'average', bucketed.average_value,
          'sample_count', bucketed.sample_count
        )
        order by bucketed.point_at
      ) filter (where bucketed.point_at is not null), '[]'::jsonb) as points
    from public.walker_observation_sensor_metadata metadata
    left join bucketed on bucketed.source_sensor_id = metadata.source_sensor_id
    where metadata.project_id = requested_project_id
      and metadata.device_id = requested_device_id
    group by
      metadata.source_sensor_id,
      metadata.display_label,
      metadata.source_pairing_name,
      metadata.position_number,
      metadata.board_serial_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'source_sensor_id', series_rows.source_sensor_id,
      'display_label', series_rows.display_label,
      'source_pairing_name', series_rows.source_pairing_name,
      'position_number', series_rows.position_number,
      'board_serial_id', series_rows.board_serial_id,
      'points', series_rows.points
    )
    order by series_rows.position_number nulls last, series_rows.source_sensor_id
  ), '[]'::jsonb)
  into series_payload
  from series_rows;

  return status_payload || jsonb_build_object(
    'range_start', range_start,
    'range_end', range_end,
    'window_hours', bounded_window_hours,
    'point_budget', bounded_point_budget,
    'bucket_seconds', bucket_seconds,
    'sensors', sensors_payload,
    'series', series_payload
  );
end;
$$;

revoke all on function public.walker_latest_recorded_snapshot(uuid, text, integer, integer) from public, anon;
grant execute on function public.walker_latest_recorded_snapshot(uuid, text, integer, integer) to authenticated;
comment on function public.walker_latest_recorded_snapshot(uuid, text, integer, integer) is
  'Bounded last recorded Walker window. Current freshness remains in the status payload. Uses the same system-admin observation boundary as live snapshots.';

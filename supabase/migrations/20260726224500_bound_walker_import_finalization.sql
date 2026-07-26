create index if not exists sensor_readings_walker_finalize_idx
  on public.sensor_readings (
    project_id,
    device_id,
    source_sensor_id,
    device_recorded_at desc,
    id desc
  )
  include (calibrated_value)
  where project_id = '33333333-3333-4333-8333-333333333331'::uuid
    and device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b';

create or replace function public.walker_observation_finalize_sensor(
  selected_source_sensor_id integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  walker_project_id constant uuid :=
    '33333333-3333-4333-8333-333333333331'::uuid;
  walker_device_id constant text :=
    'balena:a1c4ace2b367fbee8521f1aff6a6329b';
  sensor_reading_count integer;
  sensor_first_at timestamptz;
  sensor_last_at timestamptz;
  sensor_latest_value double precision;
  sensor_bucket_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may finalize a Walker sensor import';
  end if;

  if not exists (
    select 1
    from public.walker_observation_sensor_metadata
    where project_id = walker_project_id
      and device_id = walker_device_id
      and source_sensor_id = selected_source_sensor_id
  ) then
    raise exception 'Unknown Walker source sensor %', selected_source_sensor_id;
  end if;

  select
    count(*)::integer,
    min(device_recorded_at),
    max(device_recorded_at)
  into
    sensor_reading_count,
    sensor_first_at,
    sensor_last_at
  from public.sensor_readings
  where project_id = walker_project_id
    and device_id = walker_device_id
    and source_sensor_id = selected_source_sensor_id
    and event_id like
      'walker:a1c4ace2b367fbee8521f1aff6a6329b:reading:%';

  select calibrated_value
  into sensor_latest_value
  from public.sensor_readings
  where project_id = walker_project_id
    and device_id = walker_device_id
    and source_sensor_id = selected_source_sensor_id
    and event_id like
      'walker:a1c4ace2b367fbee8521f1aff6a6329b:reading:%'
  order by device_recorded_at desc, id desc
  limit 1;

  if sensor_reading_count < 1
     or sensor_first_at is null
     or sensor_last_at is null then
    raise exception
      'Walker source sensor % has no verified archive readings',
      selected_source_sensor_id;
  end if;

  update public.walker_observation_sensor_metadata
  set
    first_reading_at = sensor_first_at,
    last_reading_at = sensor_last_at,
    latest_calibrated_value = sensor_latest_value,
    reading_count = sensor_reading_count,
    updated_at = now()
  where project_id = walker_project_id
    and device_id = walker_device_id
    and source_sensor_id = selected_source_sensor_id;

  delete from public.walker_observation_trace_buckets
  where project_id = walker_project_id
    and device_id = walker_device_id
    and source_sensor_id = selected_source_sensor_id;

  insert into public.walker_observation_trace_buckets (
    project_id,
    device_id,
    source_sensor_id,
    bucket_start,
    minimum_value,
    maximum_value,
    average_value,
    sample_count
  )
  select
    walker_project_id,
    walker_device_id,
    selected_source_sensor_id,
    date_trunc('hour', reading.device_recorded_at),
    min(reading.calibrated_value),
    max(reading.calibrated_value),
    avg(reading.calibrated_value),
    count(*)::integer
  from public.sensor_readings reading
  where reading.project_id = walker_project_id
    and reading.device_id = walker_device_id
    and reading.source_sensor_id = selected_source_sensor_id
    and reading.event_id like
      'walker:a1c4ace2b367fbee8521f1aff6a6329b:reading:%'
  group by date_trunc('hour', reading.device_recorded_at);

  get diagnostics sensor_bucket_count = row_count;

  return jsonb_build_object(
    'source_sensor_id', selected_source_sensor_id,
    'reading_count', sensor_reading_count,
    'first_at', sensor_first_at,
    'last_at', sensor_last_at,
    'bucket_count', sensor_bucket_count
  );
end;
$$;

create or replace function public.walker_observation_finalize_import()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  walker_project_id constant uuid :=
    '33333333-3333-4333-8333-333333333331'::uuid;
  walker_device_id constant text :=
    'balena:a1c4ace2b367fbee8521f1aff6a6329b';
  actual_reading_count bigint;
  actual_sensor_count integer;
  actual_first_at timestamptz;
  actual_last_at timestamptz;
  actual_bucket_count bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may finalize a Walker historical import';
  end if;

  select
    count(*)::integer,
    sum(reading_count),
    min(first_reading_at),
    max(last_reading_at)
  into
    actual_sensor_count,
    actual_reading_count,
    actual_first_at,
    actual_last_at
  from public.walker_observation_sensor_metadata
  where project_id = walker_project_id
    and device_id = walker_device_id
    and reading_count > 0;

  select count(*)
  into actual_bucket_count
  from public.walker_observation_trace_buckets
  where project_id = walker_project_id
    and device_id = walker_device_id;

  if actual_reading_count <> 858720
     or actual_sensor_count <> 96
     or actual_first_at <> '2026-03-10T04:01:53Z'::timestamptz
     or actual_last_at <> '2026-07-15T03:59:57Z'::timestamptz
     or actual_bucket_count <> 194114 then
    raise exception
      'Walker archive reconciliation failed: readings %, sensors %, first %, last %, buckets %',
      actual_reading_count,
      actual_sensor_count,
      actual_first_at,
      actual_last_at,
      actual_bucket_count;
  end if;

  update public.walker_observation_imports
  set
    status = 'verified',
    imported_reading_count = actual_reading_count::integer,
    imported_sensor_count = actual_sensor_count,
    verified_at = now()
  where id = '33333333-3333-4333-8333-333333333350'::uuid;

  update public.devices
  set
    status = 'stale',
    last_seen_at = actual_last_at
  where id = walker_device_id
    and project_id = walker_project_id;

  return jsonb_build_object(
    'verified', true,
    'reading_count', actual_reading_count,
    'sensor_count', actual_sensor_count,
    'first_at', actual_first_at,
    'last_at', actual_last_at,
    'bucket_count', actual_bucket_count
  );
end;
$$;

revoke all on function public.walker_observation_finalize_sensor(integer)
  from public, anon, authenticated;
grant execute on function public.walker_observation_finalize_sensor(integer)
  to service_role;

comment on function public.walker_observation_finalize_sensor(integer) is
  'Service-only bounded finalization for one Walker historical sensor. It creates read-only visualization aggregates and no control state.';

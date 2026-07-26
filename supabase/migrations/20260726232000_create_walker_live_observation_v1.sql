-- Walker Pi 5 rolling live observation read model.
--
-- This is intentionally independent from the immutable historical archive.
-- It creates no browser-to-controller route, controller credential, command
-- record, target, schedule, pairing, calibration, or valve capability.

update public.project_platform_config
set
  capability_contract_version = '2026-07-26.walker-live-observation-v1',
  display_config = coalesce(display_config, '{}'::jsonb) ||
    jsonb_build_object(
      'system_admin_only', true,
      'expected_sensor_count', 100,
      'evidenced_sensor_count', 96,
      'default_window_hours', 72,
      'default_point_budget', 288,
      'live_ingestion_status', 'gate_b_pending',
      'archive_default_visible', false
    ) - 'historical_only',
  control_policy = jsonb_build_object(
    'mode', 'observation_only',
    'portal_control_available', false,
    'controller_write_path', 'prohibited'
  ),
  updated_at = now()
where project_id = '33333333-3333-4333-8333-333333333331'::uuid;

create table public.walker_live_telemetry_readings (
  id bigint generated always as identity primary key,
  project_id uuid not null
    references public.projects(id) on delete restrict
    check (project_id = '33333333-3333-4333-8333-333333333331'::uuid),
  device_id text not null
    references public.devices(id) on delete restrict
    check (device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'),
  source_reading_id bigint not null check (source_reading_id > 0),
  event_id text not null unique
    check (
      event_id like
        'walker:a1c4ace2b367fbee8521f1aff6a6329b:live-reading:%'
    ),
  source_sensor_id integer not null,
  sensor_key text not null,
  pairing_name text not null,
  raw_value double precision not null,
  calibrated_value double precision not null,
  temperature double precision,
  electrical_conductivity double precision,
  device_recorded_at timestamptz not null,
  source_created_at timestamptz not null,
  server_received_at timestamptz not null default now(),
  quality_flags jsonb not null default
    '{"source":"walker_live_publisher","historical":false}'::jsonb
    check (jsonb_typeof(quality_flags) = 'object'),
  unique (project_id, device_id, source_reading_id),
  foreign key (project_id, device_id, source_sensor_id)
    references public.walker_observation_sensor_metadata(
      project_id, device_id, source_sensor_id
    )
    on delete restrict
);

create index walker_live_telemetry_time_idx
  on public.walker_live_telemetry_readings (
    project_id, device_id, device_recorded_at, source_sensor_id
  );

create table public.walker_live_ingest_state (
  project_id uuid not null
    references public.projects(id) on delete restrict
    check (project_id = '33333333-3333-4333-8333-333333333331'::uuid),
  device_id text not null
    references public.devices(id) on delete restrict
    check (device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'),
  status text not null default 'gate_b_pending'
    check (status in ('gate_b_pending', 'starting', 'healthy', 'degraded', 'stopped')),
  source_cursor bigint,
  source_latest_known bigint,
  accepted_after timestamptz,
  publisher_instance text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id),
  check (source_cursor is null or source_cursor >= 0),
  check (source_latest_known is null or source_latest_known >= 0),
  check (
    source_cursor is null
    or source_latest_known is null
    or source_cursor <= source_latest_known
  )
);

insert into public.walker_live_ingest_state (project_id, device_id)
values (
  '33333333-3333-4333-8333-333333333331'::uuid,
  'balena:a1c4ace2b367fbee8521f1aff6a6329b'
);

create or replace function public.walker_live_block_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Walker live telemetry is append-only';
end;
$$;

create trigger preserve_walker_live_telemetry
before update or delete on public.walker_live_telemetry_readings
for each row execute function public.walker_live_block_mutation();

create or replace function public.walker_live_initialize_ingest(
  source_cursor bigint,
  source_latest_known bigint,
  observed_at timestamptz,
  publisher_instance text
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
  current_state public.walker_live_ingest_state%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the Walker telemetry receiver may initialize live ingest'
      using errcode = '42501';
  end if;
  if source_cursor is null
     or source_cursor < 0
     or source_latest_known is null
     or source_latest_known < source_cursor
     or observed_at is null
     or observed_at > now() + interval '5 minutes'
     or observed_at < now() - interval '15 minutes'
     or nullif(trim(publisher_instance), '') is null
     or char_length(publisher_instance) > 160 then
    raise exception 'Invalid Walker live-ingest initialization';
  end if;
  if (
    select count(*)
    from public.walker_observation_sensor_metadata
    where project_id = walker_project_id
      and device_id = walker_device_id
  ) <> 96 then
    raise exception 'Walker live ingest requires the verified 96-sensor catalog';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('exacth2o:walker-live-ingest', 0)
  );
  select *
  into current_state
  from public.walker_live_ingest_state
  where project_id = walker_project_id
    and device_id = walker_device_id
  for update;

  if current_state.accepted_after is not null then
    if current_state.source_cursor = source_cursor
       and current_state.publisher_instance = trim(publisher_instance) then
      return jsonb_build_object(
        'initialized', true,
        'idempotent', true,
        'source_cursor', current_state.source_cursor,
        'accepted_after', current_state.accepted_after
      );
    end if;
    raise exception 'Walker live ingest is already initialized';
  end if;

  update public.walker_live_ingest_state
  set
    status = 'starting',
    source_cursor = walker_live_initialize_ingest.source_cursor,
    source_latest_known = walker_live_initialize_ingest.source_latest_known,
    accepted_after = observed_at,
    publisher_instance = trim(walker_live_initialize_ingest.publisher_instance),
    last_attempt_at = now(),
    last_error = null,
    updated_at = now()
  where project_id = walker_project_id
    and device_id = walker_device_id;

  return jsonb_build_object(
    'initialized', true,
    'idempotent', false,
    'source_cursor', source_cursor,
    'accepted_after', observed_at
  );
end;
$$;

create or replace function public.ingest_walker_live_telemetry_batch(
  reading_rows jsonb,
  source_cursor bigint,
  source_latest_known bigint,
  observed_at timestamptz,
  publisher_instance text
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
  current_state public.walker_live_ingest_state%rowtype;
  invalid_count integer;
  collision_count integer;
  inserted_count integer;
  row_count integer;
  maximum_row_id bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the Walker telemetry receiver may append live readings'
      using errcode = '42501';
  end if;
  if jsonb_typeof(reading_rows) <> 'array'
     or jsonb_array_length(reading_rows) < 1
     or jsonb_array_length(reading_rows) > 1000 then
    raise exception 'reading_rows must contain between 1 and 1000 records';
  end if;
  if source_cursor is null
     or source_cursor < 0
     or source_latest_known is null
     or source_latest_known < source_cursor
     or observed_at is null
     or observed_at > now() + interval '5 minutes'
     or observed_at < now() - interval '15 minutes'
     or nullif(trim(publisher_instance), '') is null
     or char_length(publisher_instance) > 160 then
    raise exception 'Invalid Walker live-ingest batch envelope';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('exacth2o:walker-live-ingest', 0)
  );
  select *
  into current_state
  from public.walker_live_ingest_state
  where project_id = walker_project_id
    and device_id = walker_device_id
  for update;

  if current_state.accepted_after is null then
    raise exception 'Walker live ingest must be initialized at the source tail';
  end if;
  if trim(publisher_instance) <> current_state.publisher_instance then
    raise exception 'Walker publisher instance does not match initialized identity';
  end if;
  if source_cursor < coalesce(current_state.source_cursor, 0) then
    raise exception 'Walker source cursor cannot move backwards';
  end if;

  select
    count(*)::integer,
    count(*) filter (
      where row_data.source_reading_id is null
         or row_data.source_reading_id <= 0
         or row_data.source_sensor_id is null
         or row_data.raw_value is null
         or row_data.calibrated_value is null
         or row_data.device_recorded_at is null
         or row_data.source_created_at is null
         or row_data.source_created_at < current_state.accepted_after
         or row_data.source_created_at > observed_at + interval '5 minutes'
         or row_data.device_recorded_at > observed_at + interval '5 minutes'
         or row_data.source_reading_id > source_cursor
         or metadata.source_sensor_id is null
    )::integer,
    max(row_data.source_reading_id)
  into row_count, invalid_count, maximum_row_id
  from jsonb_to_recordset(reading_rows) as row_data(
    source_reading_id bigint,
    source_sensor_id integer,
    raw_value double precision,
    calibrated_value double precision,
    temperature double precision,
    electrical_conductivity double precision,
    device_recorded_at timestamptz,
    source_created_at timestamptz
  )
  left join public.walker_observation_sensor_metadata metadata
    on metadata.project_id = walker_project_id
   and metadata.device_id = walker_device_id
   and metadata.source_sensor_id = row_data.source_sensor_id;

  if invalid_count > 0 or maximum_row_id <> source_cursor then
    raise exception
      'Walker live batch contains invalid, unmapped, historical, or cursor-mismatched rows';
  end if;

  with candidate_rows as (
    select
      row_data.source_reading_id,
      row_data.source_sensor_id,
      metadata.sensor_key,
      metadata.source_pairing_name as pairing_name,
      row_data.raw_value,
      row_data.calibrated_value,
      row_data.temperature,
      row_data.electrical_conductivity,
      row_data.device_recorded_at,
      row_data.source_created_at
    from jsonb_to_recordset(reading_rows) as row_data(
      source_reading_id bigint,
      source_sensor_id integer,
      raw_value double precision,
      calibrated_value double precision,
      temperature double precision,
      electrical_conductivity double precision,
      device_recorded_at timestamptz,
      source_created_at timestamptz
    )
    join public.walker_observation_sensor_metadata metadata
      on metadata.project_id = walker_project_id
     and metadata.device_id = walker_device_id
     and metadata.source_sensor_id = row_data.source_sensor_id
  ),
  inserted as (
    insert into public.walker_live_telemetry_readings (
      project_id,
      device_id,
      source_reading_id,
      event_id,
      source_sensor_id,
      sensor_key,
      pairing_name,
      raw_value,
      calibrated_value,
      temperature,
      electrical_conductivity,
      device_recorded_at,
      source_created_at
    )
    select
      walker_project_id,
      walker_device_id,
      candidate.source_reading_id,
      'walker:a1c4ace2b367fbee8521f1aff6a6329b:live-reading:' ||
        candidate.source_reading_id,
      candidate.source_sensor_id,
      candidate.sensor_key,
      candidate.pairing_name,
      candidate.raw_value,
      candidate.calibrated_value,
      candidate.temperature,
      candidate.electrical_conductivity,
      candidate.device_recorded_at,
      candidate.source_created_at
    from candidate_rows candidate
    on conflict (event_id) do nothing
    returning 1
  )
  select count(*)::integer into inserted_count from inserted;

  select count(*)::integer
  into collision_count
  from jsonb_to_recordset(reading_rows) as row_data(
    source_reading_id bigint,
    source_sensor_id integer,
    raw_value double precision,
    calibrated_value double precision,
    temperature double precision,
    electrical_conductivity double precision,
    device_recorded_at timestamptz,
    source_created_at timestamptz
  )
  left join public.walker_live_telemetry_readings stored
    on stored.project_id = walker_project_id
   and stored.device_id = walker_device_id
   and stored.event_id =
      'walker:a1c4ace2b367fbee8521f1aff6a6329b:live-reading:' ||
        row_data.source_reading_id
  where stored.id is null
     or stored.source_sensor_id is distinct from row_data.source_sensor_id
     or stored.raw_value is distinct from row_data.raw_value
     or stored.calibrated_value is distinct from row_data.calibrated_value
     or stored.temperature is distinct from row_data.temperature
     or stored.electrical_conductivity is distinct from row_data.electrical_conductivity
     or stored.device_recorded_at is distinct from row_data.device_recorded_at
     or stored.source_created_at is distinct from row_data.source_created_at;

  if collision_count > 0 then
    raise exception 'Walker live event ID collision detected';
  end if;

  update public.walker_live_ingest_state
  set
    status = 'healthy',
    source_cursor = ingest_walker_live_telemetry_batch.source_cursor,
    source_latest_known = ingest_walker_live_telemetry_batch.source_latest_known,
    last_attempt_at = now(),
    last_success_at = now(),
    last_error = null,
    updated_at = now()
  where project_id = walker_project_id
    and device_id = walker_device_id;

  return jsonb_build_object(
    'accepted', inserted_count,
    'replayed', row_count - inserted_count,
    'source_cursor', source_cursor,
    'source_latest_known', source_latest_known
  );
end;
$$;

create or replace function public.walker_live_record_heartbeat(
  source_cursor bigint,
  source_latest_known bigint,
  observed_at timestamptz,
  publisher_instance text
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
  current_state public.walker_live_ingest_state%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the Walker telemetry receiver may record publisher health'
      using errcode = '42501';
  end if;
  if source_cursor is null
     or source_cursor < 0
     or source_latest_known is null
     or source_latest_known < source_cursor
     or observed_at is null
     or observed_at > now() + interval '5 minutes'
     or observed_at < now() - interval '15 minutes'
     or nullif(trim(publisher_instance), '') is null
     or char_length(publisher_instance) > 160 then
    raise exception 'Invalid Walker publisher heartbeat';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('exacth2o:walker-live-ingest', 0)
  );
  select *
  into current_state
  from public.walker_live_ingest_state
  where project_id = walker_project_id
    and device_id = walker_device_id
  for update;

  if current_state.accepted_after is null then
    raise exception 'Walker live ingest must be initialized at the source tail';
  end if;
  if trim(publisher_instance) <> current_state.publisher_instance then
    raise exception 'Walker publisher instance does not match initialized identity';
  end if;
  if source_cursor < coalesce(current_state.source_cursor, 0) then
    raise exception 'Walker source cursor cannot move backwards';
  end if;

  update public.walker_live_ingest_state
  set
    status = 'healthy',
    source_cursor = walker_live_record_heartbeat.source_cursor,
    source_latest_known = walker_live_record_heartbeat.source_latest_known,
    last_attempt_at = now(),
    last_success_at = now(),
    last_error = null,
    updated_at = now()
  where project_id = walker_project_id
    and device_id = walker_device_id;

  return jsonb_build_object(
    'healthy', true,
    'source_cursor', source_cursor,
    'source_latest_known', source_latest_known
  );
end;
$$;

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
  device_name text;
  state public.walker_live_ingest_state%rowtype;
  freshness text;
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

  select max(device_recorded_at), max(source_created_at)
  into latest_live_reading_at, latest_source_created_at
  from public.walker_live_telemetry_readings
  where project_id = requested_project_id
    and device_id = requested_device_id;

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

  return jsonb_build_object(
    'project_id', requested_project_id,
    'device_id', requested_device_id,
    'device_name', device_name,
    'observation_only', true,
    'portal_control_available', false,
    'expected_sensor_count', 100,
    'evidenced_sensor_count', evidenced_sensor_count,
    'missing_numeric_positions', jsonb_build_array(48, 50, 51, 100),
    'window_hours', 72,
    'freshness', freshness,
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

create or replace function public.walker_live_observation_snapshot(
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
  range_end := now();
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

alter table public.walker_live_telemetry_readings enable row level security;
alter table public.walker_live_ingest_state enable row level security;

revoke all on public.walker_live_telemetry_readings
  from public, anon, authenticated, service_role;
revoke all on public.walker_live_ingest_state
  from public, anon, authenticated, service_role;

revoke all on function public.walker_live_initialize_ingest(
  bigint, bigint, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.ingest_walker_live_telemetry_batch(
  jsonb, bigint, bigint, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.walker_live_record_heartbeat(
  bigint, bigint, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.walker_live_observation_status(uuid, text)
  from public, anon;
revoke all on function public.walker_live_observation_snapshot(
  uuid, text, integer, integer
) from public, anon;

grant execute on function public.walker_live_initialize_ingest(
  bigint, bigint, timestamptz, text
) to service_role;
grant execute on function public.ingest_walker_live_telemetry_batch(
  jsonb, bigint, bigint, timestamptz, text
) to service_role;
grant execute on function public.walker_live_record_heartbeat(
  bigint, bigint, timestamptz, text
) to service_role;
grant execute on function public.walker_live_observation_status(uuid, text)
  to authenticated, service_role;
grant execute on function public.walker_live_observation_snapshot(
  uuid, text, integer, integer
) to authenticated, service_role;

comment on table public.walker_live_telemetry_readings is
  'Append-only Walker live VWC read model. It is independent of the historical archive.';
comment on table public.walker_live_ingest_state is
  'Durable one-way Walker publisher cursor and freshness state; contains no command credentials.';
comment on function public.walker_live_observation_snapshot(
  uuid, text, integer, integer
) is
  'System-admin-only rolling Walker VWC graph payload. It never reads historical archive rows.';

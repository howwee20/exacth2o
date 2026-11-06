-- Prepare the matching UNIQUE indexes concurrently using maintenance/20261103_ingest_indexes.sql before live application.

-- A plain local restore creates these non-concurrently; live prebuilt indexes make these no-ops.

create unique index if not exists sensor_readings_device_event_key on public.sensor_readings(device_id,event_id);

create unique index if not exists valve_events_device_event_key on public.valve_events(device_id,event_id);

CREATE OR REPLACE FUNCTION public.device_ingest(device_token text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  matched_device public.devices%rowtype;
  event jsonb;
  event_type text;
  inserted_readings integer := 0;
  inserted_valves integer := 0;
  duplicate_events integer := 0;
  row_count integer := 0;
begin
  select d.*
  into matched_device
  from public.devices d
  join public.device_secrets ds on ds.device_id = d.id
  where d.id = payload->>'device_id'
    and ds.revoked_at is null
    and ds.token_hash = encode(extensions.digest(device_token, 'sha256'), 'hex')
  limit 1;

  if not found then
    raise exception 'invalid device token' using errcode = '28000';
  end if;

  for event in select * from jsonb_array_elements(coalesce(payload->'events', '[]'::jsonb))
  loop
    event_type := event->>'type';

    if event_type = 'sensor_reading' then
      insert into public.sensor_readings (
        event_id,
        organization_id,
        project_id,
        device_id,
        source_sensor_id,
        sensor_key,
        pairing_name,
        device_recorded_at,
        raw_value,
        calibrated_value,
        temperature,
        electrical_conductivity,
        unit,
        quality_flags
      )
      values (
        event->>'event_id',
        matched_device.organization_id,
        matched_device.project_id,
        matched_device.id,
        nullif(event->>'source_sensor_id', '')::integer,
        event->>'sensor_key',
        event->>'pairing_name',
        coalesce((event->>'recorded_at')::timestamptz, now()),
        nullif(event->>'raw_value', '')::double precision,
        nullif(coalesce(event->>'calibrated_value', event->>'value'), '')::double precision,
        nullif(event->>'temperature', '')::double precision,
        nullif(event->>'electrical_conductivity', '')::double precision,
        coalesce(event->>'unit', 'vwc_pct'),
        coalesce(event->'quality_flags', '{}'::jsonb)
      )
      on conflict (device_id, event_id) do nothing;
      get diagnostics row_count = row_count;
      if row_count = 1 then
        inserted_readings := inserted_readings + 1;
      else
        duplicate_events := duplicate_events + 1;
      end if;

    elsif event_type = 'valve_event' then
      insert into public.valve_events (
        event_id,
        organization_id,
        project_id,
        device_id,
        source_valve_id,
        valve_key,
        pairing_name,
        action,
        duration_ms,
        reason,
        device_recorded_at
      )
      values (
        event->>'event_id',
        matched_device.organization_id,
        matched_device.project_id,
        matched_device.id,
        nullif(event->>'source_valve_id', '')::integer,
        event->>'valve_key',
        event->>'pairing_name',
        event->>'action',
        nullif(event->>'duration_ms', '')::integer,
        event->>'reason',
        coalesce((event->>'recorded_at')::timestamptz, now())
      )
      on conflict (device_id, event_id) do nothing;
      get diagnostics row_count = row_count;
      if row_count = 1 then
        inserted_valves := inserted_valves + 1;
      else
        duplicate_events := duplicate_events + 1;
      end if;
    end if;
  end loop;

  update public.devices
  set status = 'online',
      last_seen_at = now()
  where id = matched_device.id;

  insert into public.latest_device_state (
    device_id,
    organization_id,
    project_id,
    last_seen_at,
    health_status,
    latest_payload,
    updated_at
  )
  values (
    matched_device.id,
    matched_device.organization_id,
    matched_device.project_id,
    now(),
    'online',
    jsonb_build_object(
      'sent_at', payload->>'sent_at',
      'event_count', jsonb_array_length(coalesce(payload->'events', '[]'::jsonb)),
      'inserted_readings', inserted_readings,
      'inserted_valves', inserted_valves,
      'duplicate_events', duplicate_events
    ),
    now()
  )
  on conflict (device_id) do update
  set last_seen_at = excluded.last_seen_at,
      health_status = excluded.health_status,
      latest_payload = excluded.latest_payload,
      updated_at = now();

  return jsonb_build_object(
    'ok', true,
    'device_id', matched_device.id,
    'inserted_readings', inserted_readings,
    'inserted_valves', inserted_valves,
    'duplicate_events', duplicate_events
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mirror_live_sensor_readings(reading_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  inserted_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may mirror live sensor readings';
  end if;
  if jsonb_typeof(reading_rows) <> 'array' then
    raise exception 'reading_rows must be a JSON array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('exacth2o:live-reading-mirror', 0));

  with candidate_rows as (
    select *
    from jsonb_to_recordset(reading_rows) as row_data(
      organization_id uuid,
      project_id uuid,
      device_id text,
      event_id text,
      pairing_name text,
      sensor_key text,
      raw_value double precision,
      calibrated_value double precision,
      temperature double precision,
      electrical_conductivity double precision,
      device_recorded_at timestamptz,
      server_received_at timestamptz
    )
    where project_id = '22222222-2222-4222-8222-222222222222'::uuid
      and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
      and event_id like 'live-device:%'
      and pairing_name is not null
      and calibrated_value is not null
      and device_recorded_at is not null
      and server_received_at is not null
  ), inserted as (
    insert into public.sensor_readings (
      organization_id, project_id, device_id, event_id, pairing_name, sensor_key,
      raw_value, calibrated_value, temperature, electrical_conductivity,
      device_recorded_at, server_received_at
    )
    select
      candidate.organization_id, candidate.project_id, candidate.device_id,
      candidate.event_id, candidate.pairing_name, candidate.sensor_key,
      candidate.raw_value, candidate.calibrated_value, candidate.temperature,
      candidate.electrical_conductivity, candidate.device_recorded_at,
      candidate.server_received_at
    from candidate_rows candidate
    where not exists (
      select 1 from public.sensor_readings existing
      where existing.device_id = candidate.device_id and existing.event_id = candidate.event_id
    )
    returning 1
  )
  select count(*) into inserted_count from inserted;

  return inserted_count;
end;
$function$
;

create or replace function public.walker_observation_import_readings(
  reading_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  walker_project_id constant uuid :=
    '33333333-3333-4333-8333-333333333331'::uuid;
  walker_device_id constant text :=
    'balena:a1c4ace2b367fbee8521f1aff6a6329b';
  walker_organization_id uuid;
  invalid_count integer;
  inserted_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may import Walker historical readings';
  end if;
  if jsonb_typeof(reading_rows) <> 'array'
     or jsonb_array_length(reading_rows) < 1
     or jsonb_array_length(reading_rows) > 1000 then
    raise exception 'reading_rows must contain between 1 and 1000 records';
  end if;

  select organization_id
  into walker_organization_id
  from public.projects
  where id = walker_project_id;

  if walker_organization_id is null then
    raise exception 'Walker observation project is missing';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('exacth2o:walker-historical-import', 0)
  );

  select count(*)::integer
  into invalid_count
  from jsonb_to_recordset(reading_rows) as row_data(
    source_reading_id bigint,
    source_sensor_id integer,
    sensor_key text,
    pairing_name text,
    raw_value double precision,
    calibrated_value double precision,
    temperature double precision,
    electrical_conductivity double precision,
    device_recorded_at timestamptz
  )
  left join public.walker_observation_sensor_metadata metadata
    on metadata.project_id = walker_project_id
   and metadata.device_id = walker_device_id
   and metadata.source_sensor_id = row_data.source_sensor_id
   and metadata.sensor_key = trim(row_data.sensor_key)
   and metadata.source_pairing_name = trim(row_data.pairing_name)
  where row_data.source_reading_id is null
     or row_data.source_sensor_id is null
     or row_data.raw_value is null
     or row_data.calibrated_value is null
     or row_data.device_recorded_at is null
     or metadata.source_sensor_id is null;

  if invalid_count > 0 then
    raise exception
      'Walker reading batch contains % invalid or unmapped records',
      invalid_count;
  end if;

  with candidate_rows as (
    select
      row_data.source_reading_id,
      row_data.source_sensor_id,
      trim(row_data.sensor_key) as sensor_key,
      trim(row_data.pairing_name) as pairing_name,
      row_data.raw_value,
      row_data.calibrated_value,
      row_data.temperature,
      row_data.electrical_conductivity,
      row_data.device_recorded_at
    from jsonb_to_recordset(reading_rows) as row_data(
      source_reading_id bigint,
      source_sensor_id integer,
      sensor_key text,
      pairing_name text,
      raw_value double precision,
      calibrated_value double precision,
      temperature double precision,
      electrical_conductivity double precision,
      device_recorded_at timestamptz
    )
  ),
  validated_rows as (
    select candidate.*
    from candidate_rows candidate
    join public.walker_observation_sensor_metadata metadata
      on metadata.project_id = walker_project_id
     and metadata.device_id = walker_device_id
     and metadata.source_sensor_id = candidate.source_sensor_id
     and metadata.sensor_key = candidate.sensor_key
     and metadata.source_pairing_name = candidate.pairing_name
    where candidate.source_reading_id is not null
      and candidate.source_sensor_id is not null
      and candidate.raw_value is not null
      and candidate.calibrated_value is not null
      and candidate.device_recorded_at is not null
  ),
  inserted as (
    insert into public.sensor_readings (
      event_id,
      organization_id,
      project_id,
      device_id,
      source_sensor_id,
      sensor_key,
      pairing_name,
      device_recorded_at,
      server_received_at,
      raw_value,
      calibrated_value,
      temperature,
      electrical_conductivity,
      unit,
      quality_flags
    )
    select
      'walker:a1c4ace2b367fbee8521f1aff6a6329b:reading:' ||
        candidate.source_reading_id,
      walker_organization_id,
      walker_project_id,
      walker_device_id,
      candidate.source_sensor_id,
      candidate.sensor_key,
      candidate.pairing_name,
      candidate.device_recorded_at,
      now(),
      candidate.raw_value,
      candidate.calibrated_value,
      candidate.temperature,
      candidate.electrical_conductivity,
      'vwc_pct',
      jsonb_build_object(
        'source', 'verified_walker_historical_archive',
        'historical', true
      )
    from validated_rows candidate
    on conflict (device_id, event_id) do nothing
    returning 1
  )
  select count(*)::integer
  into inserted_count
  from inserted;

  return inserted_count;
end;
$$;

alter table public.sensor_readings drop constraint sensor_readings_event_id_key;

alter table public.valve_events drop constraint valve_events_event_id_key;

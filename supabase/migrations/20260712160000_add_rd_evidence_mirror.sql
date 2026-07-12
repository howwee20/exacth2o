-- Additive evidence-quality support for the shadow-only R&D observer.
-- This migration does not alter controller commands, pairings, targets,
-- calibrations, valves, groups, or watering behavior.

alter table public.valve_events
  add column if not exists evidence_source text not null default 'unknown'
    check (evidence_source in ('owner_health_direct', 'owner_health_scalar', 'owner_health_history', 'unknown')),
  add column if not exists source_class text not null default 'unknown'
    check (source_class in ('automatic', 'manual', 'unknown')),
  add column if not exists pairing_name_raw text,
  add column if not exists pairing_resolved boolean not null default false,
  add column if not exists quality_flags jsonb not null default '[]'::jsonb;

create index if not exists valve_events_rd_observer_idx
  on public.valve_events (project_id, device_id, device_recorded_at, id);

create index if not exists sensor_readings_event_id_idx
  on public.sensor_readings (event_id);

create or replace function public.mirror_live_sensor_readings(reading_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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
      where existing.event_id = candidate.event_id
    )
    returning 1
  )
  select count(*) into inserted_count from inserted;

  return inserted_count;
end;
$$;

revoke all on function public.mirror_live_sensor_readings(jsonb)
  from public, anon, authenticated;
grant execute on function public.mirror_live_sensor_readings(jsonb) to service_role;

comment on function public.mirror_live_sensor_readings(jsonb) is
  'Idempotently mirrors verified owner-health readings for portal and shadow R&D use. No controller write path.';

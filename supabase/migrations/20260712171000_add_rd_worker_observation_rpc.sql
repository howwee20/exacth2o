-- Narrow, read-only bridge from the existing telemetry mirrors into the private
-- shadow observer. It grants no direct service-role access to portal data and
-- is permanently scoped to Matt's current project/device.

create or replace function public.rd_worker_observation(
  observation_project_id uuid,
  observation_device_id text,
  observation_since timestamptz default now() - interval '36 hours'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  matt_project_id constant uuid := '22222222-2222-4222-8222-222222222222';
  matt_device_id constant text := '3100e37ee3205651fe3dd86dafd4dc0c';
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may read the R&D worker observation';
  end if;
  if observation_project_id <> matt_project_id or observation_device_id <> matt_device_id then
    raise exception 'R&D observation is scoped to the approved shadow experiment';
  end if;
  if observation_since < now() - interval '8 days' then
    raise exception 'R&D observation window is too large';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'config', (
      select to_jsonb(config_row)
      from (
        select project_id, device_id, observed_at, pairings, calibrations,
               board_config, groups, config_hash, updated_at
        from public.device_config_state
        where project_id = matt_project_id and device_id = matt_device_id
        limit 1
      ) config_row
    ),
    'readings', coalesce((
      select jsonb_agg(to_jsonb(reading_row) order by reading_row.device_recorded_at)
      from (
        select id, event_id, pairing_name, sensor_key, raw_value,
               calibrated_value, temperature, electrical_conductivity,
               device_recorded_at, server_received_at
        from public.sensor_readings
        where project_id = matt_project_id
          and device_id = matt_device_id
          and device_recorded_at >= observation_since
          and event_id like 'live-device:%'
        order by device_recorded_at desc
        limit 12000
      ) reading_row
    ), '[]'::jsonb),
    'valve_events', coalesce((
      select jsonb_agg(to_jsonb(valve_row) order by valve_row.device_recorded_at)
      from (
        select event_id, pairing_name, action, duration_ms,
               device_recorded_at, server_received_at, evidence_source,
               source_class, pairing_resolved, quality_flags
        from public.valve_events
        where project_id = matt_project_id
          and device_id = matt_device_id
          and device_recorded_at >= observation_since
          and source_class = 'automatic'
          and pairing_resolved = true
        order by device_recorded_at desc
        limit 2000
      ) valve_row
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.rd_worker_observation(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.rd_worker_observation(uuid, text, timestamptz)
  to service_role;

comment on function public.rd_worker_observation(uuid, text, timestamptz) is
  'Read-only, Matt-scoped telemetry DTO for the private shadow ML worker.';

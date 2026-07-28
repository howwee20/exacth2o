-- Additive read-path support for Walker freshness/status checks.
-- This does not alter telemetry, controller state, RLS, or write behavior.

create index if not exists walker_live_telemetry_source_freshness_idx
  on public.walker_live_telemetry_readings (
    project_id,
    device_id,
    source_created_at desc
  )
  include (device_recorded_at, source_sensor_id);

comment on index public.walker_live_telemetry_source_freshness_idx is
  'Supports bounded Walker latest-ingest and current-sensor status reads.';

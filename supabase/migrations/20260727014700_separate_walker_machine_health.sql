-- Keep Walker Pi 5 telemetry health in its own machine-scoped observation model.
-- This read-side metadata change does not alter controller state, pairings,
-- sensing cadence, targets, schedules, calibrations, valves, or watering.

update public.project_platform_config
set
  capability_contract_version =
    '2026-07-27.walker-independent-observer-v1',
  display_config = coalesce(display_config, '{}'::jsonb) ||
    jsonb_build_object(
      'health_summary_connected', false,
      'health_scope', 'walker_machine',
      'primary_health_aggregation', false
    ),
  updated_at = now()
where project_id = '33333333-3333-4333-8333-333333333331'::uuid;

comment on function public.walker_live_observation_status(uuid, text) is
  'System-admin-only Walker machine telemetry freshness; never aggregated into primary controller health.';

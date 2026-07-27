-- Gate B is an enabled one-way read path. Runtime freshness remains sourced
-- from walker_live_ingest_state rather than this static display metadata.
update public.project_platform_config
set
  display_config =
    (coalesce(display_config, '{}'::jsonb) - 'historical_only') ||
    jsonb_build_object(
      'system_admin_only', true,
      'expected_sensor_count', 100,
      'evidenced_sensor_count', 96,
      'default_window_hours', 72,
      'default_point_budget', 288,
      'live_ingestion_status', 'enabled',
      'archive_default_visible', false
    ),
  control_policy = jsonb_build_object(
    'mode', 'observation_only',
    'portal_control_available', false,
    'controller_write_path', 'prohibited'
  ),
  updated_at = now()
where project_id = '33333333-3333-4333-8333-333333333331'::uuid;

-- Controller commands the Record explains: the deficit-pot target change (with plan version 2),
-- the Substrate v2 calibration on pots 1–8, and a board command that failed. Local fixtures only;
-- nothing here reaches a controller. Times follow the experiment's start, so they stay aligned
-- with the readings after scenario-normal shifts them. Run after the test accounts exist.
insert into public.project_control_commands (
  id, project_id, device_id, command_type, payload, status, requested_by, requested_at, expires_at,
  requires_confirmation, confirmed_at, started_at, completed_at, result, error, experiment_id, attempt_count
)
select fixture.id, '22222222-2222-4222-8222-222222222222'::uuid, device.device_id, fixture.command_type, fixture.payload,
  fixture.status, admin.id, base.start_at + fixture.requested_offset, base.start_at + fixture.requested_offset + interval '1 hour',
  true, base.start_at + fixture.requested_offset + interval '1 minute', base.start_at + fixture.done_offset - interval '20 seconds',
  base.start_at + fixture.done_offset, fixture.result, fixture.error, fixture.experiment_id, 1
from (select started_at as start_at from public.experiments where id = 'e2222222-2222-4222-8222-222222222222') base
cross join (select id from auth.users where email = 'admin@product.local') admin
cross join (
  select device_id from public.hardware_bindings
  where project_id = '22222222-2222-4222-8222-222222222222' and pairing_name = 'Zone1-Pot1' and retired_at is null limit 1
) device
cross join (values
  ('c0000000-0000-4000-8000-000000000001'::uuid, 'bulk_update_pairings', jsonb_build_object(
      'pairings', (select jsonb_agg(jsonb_build_object('pairing_name', 'Zone' || ((n - 1) / 6 + 1) || '-Pot' || n, 'target_vwc_percent', 22)) from generate_series(2, 24, 2) n),
      'reason', 'Plan version 2: deficit pots to 22% VWC'),
    'succeeded', interval '4 days 12 minutes', interval '4 days 14 minutes', '{"applied": 12}'::jsonb, null::text, 'e2222222-2222-4222-8222-222222222222'::uuid),
  ('c0000000-0000-4000-8000-000000000002'::uuid, 'apply_calibration', jsonb_build_object(
      'calibration_name', 'Substrate v2',
      'pairing_names', (select jsonb_agg('Zone' || ((n - 1) / 6 + 1) || '-Pot' || n) from generate_series(1, 8) n)),
    'succeeded', interval '8 days 10 minutes', interval '8 days 14 minutes', '{"applied": 8}'::jsonb, null::text, null::uuid),
  ('c0000000-0000-4000-8000-000000000003'::uuid, 'update_board_config', jsonb_build_object('board', 'B5', 'sample_rate_seconds', 60),
    'failed', interval '9 days 2 hours', interval '9 days 2 hours 1 minute', null::jsonb, 'Board B5 did not acknowledge within 30 s', null::uuid)
) as fixture(id, command_type, payload, status, requested_offset, done_offset, result, error, experiment_id)
on conflict (id) do nothing;

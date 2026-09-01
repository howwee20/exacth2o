update public.lighting_agent_credentials
set
  token_hash = '774bcd30a96d0694db3be96b2cf9521e0e0320fdb775cd0525ce22d255d4881f',
  enabled = true,
  rotated_at = now(),
  metadata = jsonb_build_object(
    'credential_version', 3,
    'created_for', 'beagle_jvm_lighting_bridge',
    'rotation_reason', 'diagnostic_output_rotation'
  )
where project_id = '44444444-4444-4444-8444-444444444441'::uuid
  and device_id = 'lighting:beagle';

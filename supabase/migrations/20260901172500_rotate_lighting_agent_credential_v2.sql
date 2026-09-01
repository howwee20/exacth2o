update public.lighting_agent_credentials
set
  token_hash = '5630465e8a4815d5d37589b72bed58794f55f2e78888c6006f30d34fc48675d7',
  enabled = true,
  rotated_at = now(),
  metadata = jsonb_build_object(
    'credential_version', 2,
    'created_for', 'beagle_jvm_lighting_bridge',
    'rotation_reason', 'production_bridge_install'
  )
where project_id = '44444444-4444-4444-8444-444444444441'::uuid
  and device_id = 'lighting:beagle';

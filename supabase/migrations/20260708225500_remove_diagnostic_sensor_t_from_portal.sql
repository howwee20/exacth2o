do $$
declare
  matt_project_id uuid := '22222222-2222-4222-8222-222222222222'::uuid;
begin
  delete from public.valve_events
  where project_id = matt_project_id
    and (
      pairing_name in ('CWD-lowercaseT', '720-1539')
      or source_valve_id = 1539
      or valve_key in ('1539', '0x20:3', 'D30GQN2D:0x20:3')
    );

  delete from public.sensor_readings
  where project_id = matt_project_id
    and (
      pairing_name in ('CWD-lowercaseT', '720-1539')
      or source_sensor_id = 720
      or sensor_key in ('t', 'D30GQN2D:t')
    );

  delete from public.pairings
  where project_id = matt_project_id
    and (
      name in ('CWD-lowercaseT', '720-1539')
      or source_sensor_id = 720
      or source_valve_id = 1539
      or sensor_key in ('t', 'D30GQN2D:t')
      or valve_key in ('1539', '0x20:3', 'D30GQN2D:0x20:3')
    );
end $$;

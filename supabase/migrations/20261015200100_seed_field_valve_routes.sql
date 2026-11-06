-- Physical valve routes for the greenhouse controller (plain-feather), from field observation:
-- each route below was recorded by watching water reach the physical pot. Sources:
--   pi_pairing_audit_2026-06-13/pot_pairing_ledger.csv and zone1/zone2_final_verified_2026-06-15
--   researcher_20_pot_handoff_2026-06-16.md (lines from 86-90 moved to physical pots 96-100)
--   August 3, 2026 field test of pots 73-76 (one-position shift found after 0x20:25)
-- Where records conflict or water was not observed, the pot needs a physical check before use.
-- Runs only where that controller exists; disposable test databases are unaffected.
do $$
declare
  project constant uuid := '22222222-2222-4222-8222-222222222222';
  device constant text := '3100e37ee3205651fe3dd86dafd4dc0c';
begin
  if not exists (select 1 from public.device_config_state where project_id=project and device_id=device) then return; end if;

  insert into public.manual_valve_routes(project_id,device_id,pot_number,status,relay_address,channel,source,evidence)
  select project, device, pot, status, relay, chan, source, evidence from (
    select pot, 'confirmed' status, 36 relay, pot chan, 'field_record_2026-06-15' source,
      'Zone 1 field passes June 13 and 15: watered in order.' evidence from generate_series(1,25) pot
    union all
    select pot, 'confirmed', 36, pot, 'field_record_2026-06-15',
      'Zone 2 heavy passes June 13 and 15: visible flow, in order.' from generate_series(26,48) pot
    union all
    select pot, 'confirmed', 32, pot-48, 'field_record_2026-06-15',
      'Zone 2 heavy passes June 13 and 15: visible flow, in order.' from generate_series(49,50) pot
    union all
    select pot, 'confirmed', 32, pot-48, 'field_record_2026-06-13',
      'Zone 3 repeat pass June 13: watered in order.' from generate_series(51,72) pot where pot not in (58,63)
    union all
    select 58, 'needs_confirmation', 32, 10, 'field_record_2026-06-13',
      'Mapped to 0x20:10 on June 13, but no water came out on the repeat pass.'
    union all
    select 63, 'needs_confirmation', 32, 15, 'field_record_2026-06-13',
      'Mapped to 0x20:15 on June 13, but no water came out on the repeat pass.'
    union all
    select 73, 'confirmed', 32, 25, 'field_test_2026-08-03',
      'August 3 field test: 0x20:25 watered physical pot 73.'
    union all
    select 74, 'needs_confirmation', 32, 26, 'field_test_2026-08-03',
      'June 13 record: 0x20:27. August 3 repair moved pot 74 to 0x20:26 (printed SSR 74) after tubing changes; not observed since.'
    union all
    select 75, 'needs_confirmation', 32, 27, 'field_test_2026-08-03',
      'August 3: 0x20:27 watered physical pot 75 before tubing was moved; not re-tested since.'
    union all
    select 76, 'needs_confirmation', null, null, 'field_test_2026-08-03',
      'Records conflict: June 15 0x20:29; August 3 0x20:28 watered physical pot 76 before tubing was moved.'
    union all
    select pot, 'needs_confirmation', 32, pot-47, 'field_record_2026-06-15',
      'June 15 field pass recorded this valve. A one-position shift was found at pots 74-76 in August; pots 77-85 were not re-tested.'
      from generate_series(77,85) pot
    union all
    select pot, 'no_water_line', null, null, 'field_record_2026-06-16',
      'June 16: the water lines from valves 0x20:39-43 were moved to physical pots 96-100. This pot has no line.' from generate_series(86,90) pot
    union all
    select pot, 'confirmed', 32, pot-47, 'field_record_2026-06-16',
      'Zone 4 field pass June 15 and water run June 16: watered in order.' from generate_series(91,95) pot
    union all
    select pot, 'confirmed', 32, pot-57, 'field_record_2026-06-16',
      'June 16: lines from valves 0x20:39-43 re-piped to pots 96-100; order visually confirmed.' from generate_series(96,100) pot
  ) seeded(pot, status, relay, chan, source, evidence)
  on conflict (project_id,device_id,pot_number) do nothing;

  insert into public.project_control_audit(project_id,device_id,action,actor_id,status,details)
  values (project, device, 'manual_route_seed', null, 'field_record',
          jsonb_build_object('confirmed', (select count(*) from public.manual_valve_routes where project_id=project and device_id=device and status='confirmed'),
                             'needs_confirmation', (select count(*) from public.manual_valve_routes where project_id=project and device_id=device and status='needs_confirmation'),
                             'no_water_line', (select count(*) from public.manual_valve_routes where project_id=project and device_id=device and status='no_water_line')));
end $$;

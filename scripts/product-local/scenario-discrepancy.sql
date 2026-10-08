-- The plan says 22% for deficit pots, but the controller applies 25% on pots 2, 10 and 18.
\ir scenario-normal.sql
update public.device_config_state
set pairings = (
  select jsonb_agg(case when pairing ->> 'name' in ('Zone1-Pot2', 'Zone2-Pot10', 'Zone3-Pot18')
    then jsonb_set(pairing, '{WTCPercentLimit}', '25'::jsonb) else pairing end order by (pairing ->> 'sensorId')::int)
  from jsonb_array_elements(pairings) as pairing
), updated_at = now()
where project_id = '22222222-2222-4222-8222-222222222222';

-- One-time data migration for the existing greenhouse installation.
--
-- Runtime application code does not depend on these IDs, names, crops, or pot
-- numbers. This records the current researcher-approved experiment structure
-- as database data. It does not change controller configuration or watering.

update public.research_sites
set timezone = 'America/Detroit',
    updated_at = now()
where project_id = '22222222-2222-4222-8222-222222222222'::uuid
  and slug = 'primary';

update public.experiment_assignments assignment
set
  crop = case
    when assignment.pot_number between 15 and 26 then 'Maize'
    when assignment.pot_number between 65 and 76 then 'Sorghum'
    else assignment.crop
  end,
  treatment = case
    when assignment.pot_number in (15,17,19,21,23,25,65,67,69,71,73,75) then 'Control'
    when assignment.pot_number in (16,18,20,22,24,26,66,68,70,72,74,76) then 'Drought'
    else assignment.treatment
  end,
  target_vwc_percent = case
    when assignment.pot_number in (15,17,19,21,23,25,65,67,69,71,73,75) then 30
    when assignment.pot_number in (16,18,20,22,24,26,66,68,70,72,74,76) then 10
    else assignment.target_vwc_percent
  end
where assignment.experiment_id = 'e2222222-2222-4222-8222-222222222222'::uuid;

update public.experiments
set description = '10% drought · 30% control',
    updated_at = now()
where id = 'e2222222-2222-4222-8222-222222222222'::uuid;

update public.experiments
set description = 'Sensing only',
    updated_at = now()
where id = 'e3333333-3333-4333-8333-333333333333'::uuid
  and watering_state = 'off';

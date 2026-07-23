-- Retire the removed Oven-Dry portal experiment and admit the replacement
-- SWC saturation calibration workflow. Historical sensor readings remain
-- immutable; only experiment-scoped Calibration Studio records are retired.

delete from public.calibration_set_requests
where study_id in (
  select id
  from public.calibration_studies
  where experiment_id = 'oven-dry-experiment'
);

delete from public.calibration_studies
where experiment_id = 'oven-dry-experiment';

alter table public.calibration_studies
  drop constraint if exists calibration_studies_experiment_id_check;

alter table public.calibration_studies
  add constraint calibration_studies_experiment_id_check
  check (
    experiment_id in (
      'matt-experiment',
      'matt-experiment-2',
      'swc-saturation-calibration'
    )
  );

notify pgrst, 'reload schema';

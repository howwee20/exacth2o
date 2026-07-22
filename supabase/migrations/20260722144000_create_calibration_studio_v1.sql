-- ExactH2O Calibration Studio V1 stores reference measurements and generated
-- equation candidates separately from controller-applied calibrations. Nothing
-- in this migration changes pairings, targets, valves, watering, or controller
-- state.

create table if not exists public.calibration_studies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  experiment_id text not null check (experiment_id in ('matt-experiment', 'matt-experiment-2', 'oven-dry-experiment')),
  name text not null check (char_length(name) between 1 and 160),
  pairing_name text not null check (char_length(pairing_name) between 1 and 120),
  sensor_key text not null check (char_length(sensor_key) between 1 and 120),
  reference_instrument text,
  reference_units text not null default 'VWC %' check (reference_units = 'VWC %'),
  match_tolerance_seconds integer not null default 300 check (match_tolerance_seconds between 30 and 1800),
  status text not null default 'draft' check (status in ('draft', 'candidate', 'set_requested', 'archived')),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id)
);

create table if not exists public.calibration_observations (
  id uuid primary key default gen_random_uuid(),
  study_id uuid not null,
  project_id uuid not null,
  reference_recorded_at timestamptz not null,
  reference_vwc double precision not null check (reference_vwc between 0 and 100),
  sensor_reading_id bigint,
  matched_event_id text,
  sensor_recorded_at timestamptz,
  raw_value double precision,
  current_calibrated_value double precision,
  time_delta_seconds integer check (time_delta_seconds is null or time_delta_seconds >= 0),
  match_status text not null check (match_status in ('matched', 'unmatched')),
  included boolean not null default true,
  notes text check (notes is null or char_length(notes) <= 500),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (study_id, project_id)
    references public.calibration_studies(id, project_id)
    on delete cascade,
  check (
    (match_status = 'matched' and sensor_reading_id is not null and sensor_recorded_at is not null and raw_value is not null)
    or
    (match_status = 'unmatched' and sensor_reading_id is null and sensor_recorded_at is null and raw_value is null)
  )
);

create table if not exists public.calibration_candidates (
  id uuid primary key default gen_random_uuid(),
  study_id uuid not null,
  project_id uuid not null,
  version integer not null check (version > 0),
  fit_type text not null check (fit_type in ('linear', 'quadratic')),
  coefficients jsonb not null check (jsonb_typeof(coefficients) = 'array'),
  equation_text text not null check (char_length(equation_text) between 1 and 500),
  sample_count integer not null check (sample_count >= 3),
  raw_min double precision not null,
  raw_max double precision not null,
  reference_min double precision not null,
  reference_max double precision not null,
  rmse double precision not null check (rmse >= 0),
  mae double precision not null check (mae >= 0),
  r_squared double precision not null,
  max_error double precision not null check (max_error >= 0),
  status text not null check (status in ('preview', 'ready', 'archived')),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (study_id, project_id)
    references public.calibration_studies(id, project_id)
    on delete cascade,
  unique (study_id, version),
  unique (id, study_id, project_id)
);

create table if not exists public.calibration_set_requests (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null,
  study_id uuid not null,
  project_id uuid not null,
  pairing_names text[] not null check (cardinality(pairing_names) between 1 and 100),
  status text not null default 'approval_requested' check (status in ('approval_requested', 'approved', 'applied', 'rejected', 'failed')),
  requested_by uuid not null default auth.uid() references auth.users(id),
  requested_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  controller_command_ids uuid[] not null default '{}',
  notes text check (notes is null or char_length(notes) <= 1000),
  foreign key (study_id, project_id)
    references public.calibration_studies(id, project_id)
    on delete restrict,
  foreign key (candidate_id, study_id, project_id)
    references public.calibration_candidates(id, study_id, project_id)
    on delete restrict
);

create index if not exists calibration_studies_project_experiment_idx
  on public.calibration_studies (project_id, experiment_id, updated_at desc);
create index if not exists calibration_observations_study_time_idx
  on public.calibration_observations (study_id, reference_recorded_at desc);
create index if not exists calibration_candidates_study_version_idx
  on public.calibration_candidates (study_id, version desc);
create index if not exists calibration_set_requests_project_status_idx
  on public.calibration_set_requests (project_id, status, requested_at desc);
create index if not exists sensor_readings_project_pairing_recorded_idx
  on public.sensor_readings (project_id, pairing_name, device_recorded_at desc, id desc);

create or replace function public.touch_calibration_study_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists calibration_studies_touch_updated_at on public.calibration_studies;
create trigger calibration_studies_touch_updated_at
before update on public.calibration_studies
for each row execute function public.touch_calibration_study_updated_at();

drop trigger if exists calibration_observations_touch_updated_at on public.calibration_observations;
create trigger calibration_observations_touch_updated_at
before update on public.calibration_observations
for each row execute function public.touch_calibration_study_updated_at();

alter table public.calibration_studies enable row level security;
alter table public.calibration_observations enable row level security;
alter table public.calibration_candidates enable row level security;
alter table public.calibration_set_requests enable row level security;

drop policy if exists "project members read calibration studies" on public.calibration_studies;
create policy "project members read calibration studies"
  on public.calibration_studies for select to authenticated
  using (public.has_portal_access(project_id));

drop policy if exists "project members create calibration studies" on public.calibration_studies;
create policy "project members create calibration studies"
  on public.calibration_studies for insert to authenticated
  with check (public.has_portal_access(project_id) and created_by = (select auth.uid()));

drop policy if exists "study owners manage calibration studies" on public.calibration_studies;
create policy "study owners manage calibration studies"
  on public.calibration_studies for update to authenticated
  using (
    created_by = (select auth.uid())
    or project_id in (select allowed_project_id from public.portal_admin_project_ids())
  )
  with check (
    public.has_portal_access(project_id)
    and (
      created_by = (select auth.uid())
      or project_id in (select allowed_project_id from public.portal_admin_project_ids())
    )
  );

drop policy if exists "project members read calibration observations" on public.calibration_observations;
create policy "project members read calibration observations"
  on public.calibration_observations for select to authenticated
  using (public.has_portal_access(project_id));

drop policy if exists "project members create calibration observations" on public.calibration_observations;
create policy "project members create calibration observations"
  on public.calibration_observations for insert to authenticated
  with check (public.has_portal_access(project_id) and created_by = (select auth.uid()));

drop policy if exists "observation owners manage calibration observations" on public.calibration_observations;
create policy "observation owners manage calibration observations"
  on public.calibration_observations for update to authenticated
  using (
    created_by = (select auth.uid())
    or project_id in (select allowed_project_id from public.portal_admin_project_ids())
  )
  with check (
    public.has_portal_access(project_id)
    and (
      created_by = (select auth.uid())
      or project_id in (select allowed_project_id from public.portal_admin_project_ids())
    )
  );

drop policy if exists "observation owners delete calibration observations" on public.calibration_observations;
create policy "observation owners delete calibration observations"
  on public.calibration_observations for delete to authenticated
  using (
    created_by = (select auth.uid())
    or project_id in (select allowed_project_id from public.portal_admin_project_ids())
  );

drop policy if exists "project members read calibration candidates" on public.calibration_candidates;
create policy "project members read calibration candidates"
  on public.calibration_candidates for select to authenticated
  using (public.has_portal_access(project_id));

drop policy if exists "project members create calibration candidates" on public.calibration_candidates;
create policy "project members create calibration candidates"
  on public.calibration_candidates for insert to authenticated
  with check (public.has_portal_access(project_id) and created_by = (select auth.uid()));

drop policy if exists "project members read calibration set requests" on public.calibration_set_requests;
create policy "project members read calibration set requests"
  on public.calibration_set_requests for select to authenticated
  using (public.has_portal_access(project_id));

drop policy if exists "admins request calibration setting" on public.calibration_set_requests;
create policy "admins request calibration setting"
  on public.calibration_set_requests for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and project_id in (select allowed_project_id from public.portal_admin_project_ids())
  );

revoke all on table public.calibration_studies from public, anon;
revoke all on table public.calibration_observations from public, anon;
revoke all on table public.calibration_candidates from public, anon;
revoke all on table public.calibration_set_requests from public, anon;
grant select, insert, update on table public.calibration_studies to authenticated;
grant select, insert, update, delete on table public.calibration_observations to authenticated;
grant select, insert on table public.calibration_candidates to authenticated;
grant select, insert on table public.calibration_set_requests to authenticated;

comment on table public.calibration_studies is
  'External-reference calibration workspaces; isolated from controller-applied calibration state.';
comment on table public.calibration_candidates is
  'Immutable generated equation candidates. Candidate creation never applies a calibration.';
comment on table public.calibration_set_requests is
  'Admin-only approval queue; V1 records intent but does not directly mutate the controller.';

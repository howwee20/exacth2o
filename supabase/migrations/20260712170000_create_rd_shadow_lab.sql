-- UNAPPLIED STAGING PACKAGE.
-- Additive R&D schema only. This migration does not touch controller, command,
-- pairing, calibration, sensor, valve, group, target, or watering tables.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.rd_system_admin_access (
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (project_id, user_id)
);

alter table public.rd_system_admin_access enable row level security;
revoke all on table public.rd_system_admin_access from public, anon, authenticated;
grant select, insert, update, delete on table public.rd_system_admin_access to service_role;

create or replace function public.has_rd_system_admin_access(check_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.rd_system_admin_access access
    where access.project_id = check_project_id
      and access.user_id = auth.uid()
      and access.enabled = true
      and access.revoked_at is null
  );
$$;

revoke all on function public.has_rd_system_admin_access(uuid) from public, anon;
grant execute on function public.has_rd_system_admin_access(uuid) to authenticated, service_role;

create table if not exists public.rd_model_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  status text not null check (status in ('baseline', 'candidate', 'champion', 'retired')),
  artifact_path text,
  artifact_sha256 text,
  feature_schema_version text not null,
  training_dataset_hash text,
  training_event_count integer not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  synthetic_data_only boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.rd_training_runs (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid references public.rd_model_versions(id) on delete set null,
  code_commit text not null,
  dataset_hash text not null,
  parameters jsonb not null default '{}'::jsonb,
  training_event_count integer not null,
  held_out_event_count integer not null,
  result text not null check (result in ('running', 'succeeded', 'failed', 'rejected')),
  metrics jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.rd_model_promotions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  model_version_id uuid not null references public.rd_model_versions(id),
  previous_model_version_id uuid references public.rd_model_versions(id),
  decision text not null check (decision in ('promoted', 'rolled_back', 'rejected')),
  evidence jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.rd_irrigation_episodes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  device_id text not null,
  pairing_name text not null,
  first_open_event_id text not null,
  first_open_device_at timestamptz not null,
  episode_kind text not null check (
    episode_kind in (
      'automatic_first_pulse', 'manual_pulse', 'conflict_retry', 'unknown_source'
    )
  ),
  target_vwc_at_open double precision not null,
  config_hash_at_open text not null,
  pulse_count integer not null default 1 check (pulse_count > 0),
  censor_at timestamptz,
  censor_reason text,
  quality jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, device_id, first_open_event_id)
);

create index if not exists rd_episodes_pairing_time_idx
  on public.rd_irrigation_episodes (project_id, device_id, pairing_name, first_open_device_at desc);

create table if not exists public.rd_curve_predictions (
  id uuid primary key default gen_random_uuid(),
  prediction_key text not null unique,
  project_id uuid not null,
  device_id text not null,
  pairing_name text not null,
  episode_id uuid references public.rd_irrigation_episodes(id) on delete set null,
  model_version_id uuid not null references public.rd_model_versions(id),
  band text not null check (band in ('early', 'refresh', 'revision')),
  trigger_reading_id bigint,
  trigger_vwc double precision not null,
  target_vwc_at_issue double precision not null,
  configured_valve_open_ms integer not null,
  measurement_interval_ms integer not null,
  calibration_version text not null,
  config_hash text not null,
  feature_as_of_device_at timestamptz not null,
  issued_at timestamptz not null,
  feature_hash text not null,
  features jsonb not null,
  p10 jsonb not null,
  p50 jsonb not null,
  p90 jsonb not null,
  confidence text not null check (confidence in ('trained_range', 'low_confidence', 'out_of_distribution')),
  created_at timestamptz not null default now()
);

create index if not exists rd_predictions_project_time_idx
  on public.rd_curve_predictions (project_id, issued_at desc);
create index if not exists rd_predictions_pairing_time_idx
  on public.rd_curve_predictions (project_id, device_id, pairing_name, feature_as_of_device_at desc);

create or replace function public.rd_enforce_committed_prediction_causality()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  prediction_record public.rd_curve_predictions%rowtype;
  first_open_at timestamptz;
begin
  if new.state <> 'committed' then
    return new;
  end if;
  first_open_at := nullif(new.details ->> 'irrigation_opened_device_at', '')::timestamptz;
  if first_open_at is null then
    raise exception 'Committed predictions require irrigation_opened_device_at';
  end if;
  select * into prediction_record
  from public.rd_curve_predictions
  where id = new.prediction_id;
  if not found
     or prediction_record.feature_as_of_device_at >= first_open_at
     or prediction_record.issued_at >= first_open_at then
    raise exception 'Prediction is not causal relative to first valve-open device time';
  end if;
  return new;
end;
$$;

revoke all on function public.rd_enforce_committed_prediction_causality()
  from public, anon, authenticated;

create table if not exists public.rd_prediction_events (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references public.rd_curve_predictions(id) on delete restrict,
  state text not null check (
    state in (
      'armed_early', 'armed_refresh', 'committed', 'expired_no_event',
      'missed_causal_window', 'aborted_config_change', 'tracking_response', 'scored'
    )
  ),
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists rd_prediction_events_latest_idx
  on public.rd_prediction_events (prediction_id, occurred_at desc);

drop trigger if exists rd_committed_prediction_causality on public.rd_prediction_events;
create trigger rd_committed_prediction_causality
before insert on public.rd_prediction_events
for each row execute function public.rd_enforce_committed_prediction_causality();

create table if not exists public.rd_curve_outcomes (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null unique references public.rd_irrigation_episodes(id) on delete restrict,
  baseline_vwc double precision not null,
  baseline_reading_id bigint,
  actual_absolute jsonb not null,
  actual_delta jsonb not null,
  observed_horizons integer not null check (observed_horizons >= 0),
  censored boolean not null default false,
  censor_reason text,
  eligible_for_training boolean not null default false,
  quality_reasons jsonb not null default '[]'::jsonb,
  completed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.rd_prediction_scores (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null unique references public.rd_curve_predictions(id) on delete restrict,
  outcome_id uuid not null references public.rd_curve_outcomes(id) on delete restrict,
  curve_mae double precision,
  peak_error double precision,
  time_to_peak_error_minutes double precision,
  integrated_response_error double precision,
  interval_coverage double precision,
  scored_horizons integer not null check (scored_horizons >= 0),
  scoring_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.rd_pairing_adapters (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  device_id text not null,
  pairing_name text not null,
  model_version_id uuid not null references public.rd_model_versions(id),
  adapter_version text not null,
  status text not null check (status in ('shadow', 'validated', 'retired')),
  artifact_path text not null,
  artifact_sha256 text not null,
  events_incorporated integer not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, device_id, pairing_name, model_version_id, adapter_version)
);

create table if not exists public.rd_jobs (
  id uuid primary key default gen_random_uuid(),
  job_key text not null unique,
  job_type text not null check (job_type in ('predict', 'commit', 'observe', 'score', 'train')),
  project_id uuid not null,
  device_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists rd_jobs_claim_idx
  on public.rd_jobs (available_at, created_at)
  where status = 'queued';

create table if not exists public.rd_observer_state (
  project_id uuid not null,
  device_id text not null,
  pairing_name text not null,
  last_reading_id bigint,
  previous_vwc double precision,
  active_band text,
  active_prediction_id uuid references public.rd_curve_predictions(id) on delete set null,
  active_episode_id uuid references public.rd_irrigation_episodes(id) on delete set null,
  config_hash text,
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id, pairing_name)
);

create table if not exists public.rd_access_audit (
  id bigint generated always as identity primary key,
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  prediction_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists rd_one_champion_idx
  on public.rd_model_versions (status)
  where status = 'champion';

create or replace function public.rd_guard_model_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'champion'
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and current_setting('exacth2o.rd_promotion_context', true) <> 'authorized' then
    raise exception 'Champion status may only be assigned through promote_rd_model';
  end if;
  return new;
end;
$$;

revoke all on function public.rd_guard_model_status_change() from public, anon, authenticated;
drop trigger if exists rd_model_status_guard on public.rd_model_versions;
create trigger rd_model_status_guard
before insert or update of status on public.rd_model_versions
for each row execute function public.rd_guard_model_status_change();

create or replace function public.promote_rd_model(
  promote_project_id uuid,
  promote_model_version_id uuid,
  promotion_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_model_id uuid;
  promotion_id uuid;
  candidate_is_synthetic boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may promote R&D models';
  end if;
  if coalesce((promotion_evidence ->> 'qualified_evaluation_windows')::integer, 0) < 2 then
    raise exception 'Promotion requires at least two qualified evaluation windows';
  end if;
  select synthetic_data_only into candidate_is_synthetic
  from public.rd_model_versions
  where id = promote_model_version_id and status = 'candidate'
  for update;
  if not found or candidate_is_synthetic then
    raise exception 'Only a non-synthetic candidate may be promoted';
  end if;
  select id into previous_model_id
  from public.rd_model_versions
  where status = 'champion'
  for update;

  perform set_config('exacth2o.rd_promotion_context', 'authorized', true);
  if previous_model_id is not null then
    update public.rd_model_versions set status = 'retired' where id = previous_model_id;
  end if;
  insert into public.rd_model_promotions (
    project_id, model_version_id, previous_model_version_id, decision, evidence, actor_id
  ) values (
    promote_project_id, promote_model_version_id, previous_model_id, 'promoted',
    promotion_evidence, auth.uid()
  ) returning id into promotion_id;
  update public.rd_model_versions set status = 'champion' where id = promote_model_version_id;
  return promotion_id;
end;
$$;

revoke all on function public.promote_rd_model(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.promote_rd_model(uuid, uuid, jsonb) to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'rd_model_versions', 'rd_training_runs', 'rd_model_promotions',
    'rd_irrigation_episodes', 'rd_curve_predictions', 'rd_prediction_events',
    'rd_curve_outcomes', 'rd_prediction_scores', 'rd_pairing_adapters',
    'rd_jobs', 'rd_observer_state', 'rd_access_audit'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end $$;

grant usage, select on sequence public.rd_access_audit_id_seq to service_role;

create or replace function public.rd_block_immutable_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'R&D scientific records are append-only';
end;
$$;

revoke all on function public.rd_block_immutable_mutation() from public, anon, authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'rd_curve_predictions', 'rd_prediction_events', 'rd_curve_outcomes',
    'rd_prediction_scores', 'rd_training_runs', 'rd_model_promotions'
  ] loop
    execute format('drop trigger if exists rd_immutable_guard on public.%I', table_name);
    execute format(
      'create trigger rd_immutable_guard before update or delete on public.%I '
      'for each row execute function public.rd_block_immutable_mutation()',
      table_name
    );
  end loop;
end $$;

create or replace function public.claim_rd_jobs(
  claim_worker text,
  claim_limit integer default 10,
  claim_lease_seconds integer default 120
)
returns setof public.rd_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may claim R&D jobs';
  end if;
  return query
  with candidates as (
    select jobs.id
    from public.rd_jobs jobs
    where jobs.status = 'queued'
      and jobs.available_at <= now()
    order by jobs.available_at, jobs.created_at
    for update skip locked
    limit greatest(1, least(claim_limit, 50))
  )
  update public.rd_jobs jobs
  set status = 'running',
      lease_owner = claim_worker,
      lease_expires_at = now() + make_interval(secs => greatest(30, claim_lease_seconds)),
      attempt_count = jobs.attempt_count + 1
  from candidates
  where jobs.id = candidates.id
  returning jobs.*;
end;
$$;

revoke all on function public.claim_rd_jobs(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_rd_jobs(text, integer, integer) to service_role;

comment on table public.rd_curve_predictions is
  'Immutable shadow forecasts. Browser access is only through the system-admin DTO function.';
comment on table public.rd_jobs is
  'R&D-only jobs with an independent lease. Never shared with health ingestion or controller commands.';

-- R&D tables are intentionally not added to supabase_realtime. The admin Lab
-- polls a protected DTO endpoint; Realtime is not a correctness dependency.

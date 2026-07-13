-- Corrected, additive scientific contract for the shadow-only response lab.
-- Existing v2 evidence remains immutable. This migration has no controller,
-- command, pairing, calibration, target, group, sensor, or watering writes.

create table if not exists public.rd_episode_outcomes_v3 (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null unique
    references public.rd_correction_episodes_v2(id) on delete restrict,
  project_id uuid not null,
  device_id text not null,
  pairing_name text not null,
  baseline_vwc double precision not null,
  baseline_reading_id bigint,
  baseline_device_at timestamptz not null,
  first_open_device_at timestamptz not null,
  last_open_device_at timestamptz not null,
  config_hash_at_start text not null,
  observation_end_device_at timestamptz not null,
  actual_absolute jsonb not null,
  actual_delta jsonb not null,
  observed_horizons integer not null check (observed_horizons >= 0),
  pulse_count integer not null check (pulse_count > 0),
  sample_interval_minutes integer not null default 10
    check (sample_interval_minutes > 0),
  right_censored boolean not null default false,
  eligible_for_scoring boolean not null default false,
  eligible_for_training boolean not null default false,
  quality_reasons jsonb not null default '[]'::jsonb,
  outcome_version text not null default 'episode-total-first-open-v2',
  completed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists rd_episode_outcomes_v3_training_idx
  on public.rd_episode_outcomes_v3
  (project_id, completed_at, pairing_name)
  where eligible_for_training = true;

create table if not exists public.rd_episode_scores_v3 (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null
    references public.rd_correction_episodes_v2(id) on delete restrict,
  outcome_id uuid not null
    references public.rd_episode_outcomes_v3(id) on delete restrict,
  model_version_id uuid not null
    references public.rd_model_versions(id) on delete restrict,
  model_role text not null check (model_role in ('baseline', 'candidate', 'champion')),
  curve_mae double precision,
  peak_error double precision,
  time_to_peak_error_minutes double precision,
  integrated_response_error double precision,
  interval_coverage double precision,
  scored_horizons integer not null check (scored_horizons >= 0),
  scoring_version text not null default 'episode-first-open-score-v2',
  created_at timestamptz not null default now(),
  unique (episode_id, model_version_id, scoring_version)
);

alter table public.rd_episode_outcomes_v3 enable row level security;
alter table public.rd_episode_scores_v3 enable row level security;
revoke all on table public.rd_episode_outcomes_v3 from public, anon, authenticated;
revoke all on table public.rd_episode_scores_v3 from public, anon, authenticated;
grant select, insert on table public.rd_episode_outcomes_v3 to service_role;
grant select, insert on table public.rd_episode_scores_v3 to service_role;

drop trigger if exists rd_immutable_guard on public.rd_episode_outcomes_v3;
create trigger rd_immutable_guard before update or delete
on public.rd_episode_outcomes_v3 for each row
execute function public.rd_block_immutable_mutation();

drop trigger if exists rd_immutable_guard on public.rd_episode_scores_v3;
create trigger rd_immutable_guard before update or delete
on public.rd_episode_scores_v3 for each row
execute function public.rd_block_immutable_mutation();

create or replace function public.rd_episode_observation_v3(
  observation_episode_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_episode public.rd_correction_episodes_v2%rowtype;
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may read an R&D episode observation';
  end if;
  select * into selected_episode
  from public.rd_correction_episodes_v2
  where id = observation_episode_id
    and project_id = '22222222-2222-4222-8222-222222222222'::uuid
    and device_id = '3100e37ee3205651fe3dd86dafd4dc0c';
  if not found then
    raise exception 'Approved R&D episode not found';
  end if;

  select jsonb_build_object(
    'episode_id', selected_episode.id,
    'readings', coalesce((
      select jsonb_agg(to_jsonb(reading_row) order by reading_row.device_recorded_at)
      from (
        select id, event_id, pairing_name, sensor_key, raw_value,
               calibrated_value, temperature, electrical_conductivity,
               device_recorded_at, server_received_at
        from public.sensor_readings
        where project_id = selected_episode.project_id
          and device_id = selected_episode.device_id
          and pairing_name = selected_episode.pairing_name
          and device_recorded_at >= selected_episode.first_open_device_at - interval '20 minutes'
          and device_recorded_at <= selected_episode.last_open_device_at + interval '250 minutes'
          and event_id like 'live-device:%'
        order by device_recorded_at
        limit 1000
      ) reading_row
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.rd_episode_observation_v3(uuid)
  from public, anon, authenticated;
grant execute on function public.rd_episode_observation_v3(uuid) to service_role;

create or replace function public.rd_worker_predictions_v3(
  observation_project_id uuid,
  recent_since timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may read R&D prediction state';
  end if;
  if observation_project_id <> '22222222-2222-4222-8222-222222222222'::uuid then
    raise exception 'R&D prediction state is scoped to the approved experiment';
  end if;
  if recent_since < now() - interval '8 days' then
    raise exception 'R&D prediction window is too large';
  end if;

  with latest as (
    select distinct on (event.prediction_id)
      event.prediction_id, event.state, event.occurred_at
    from public.rd_prediction_events event
    order by event.prediction_id, event.occurred_at desc
  ), selected as (
    select prediction.id, prediction.prediction_key, prediction.pairing_name,
           prediction.model_version_id, prediction.band, prediction.trigger_vwc,
           prediction.target_vwc_at_issue, prediction.configured_valve_open_ms,
           prediction.measurement_interval_ms, prediction.calibration_version,
           prediction.config_hash, prediction.feature_as_of_device_at,
           prediction.issued_at, prediction.p10, prediction.p50, prediction.p90,
           latest.state as latest_state, latest.occurred_at as latest_state_at
    from public.rd_curve_predictions prediction
    left join latest on latest.prediction_id = prediction.id
    where prediction.project_id = observation_project_id
      and (
        prediction.issued_at >= recent_since
        or latest.state in ('armed_early', 'armed_refresh')
      )
    order by prediction.issued_at desc, prediction.id desc
  )
  select coalesce(jsonb_agg(to_jsonb(selected)), '[]'::jsonb)
  into result from selected;
  return result;
end;
$$;

revoke all on function public.rd_worker_predictions_v3(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.rd_worker_predictions_v3(uuid, timestamptz)
  to service_role;

create or replace function public.claim_rd_jobs_v3(
  claim_worker text,
  claim_kind text,
  claim_limit integer default 1,
  claim_lease_seconds integer default 900
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
    where jobs.job_type = claim_kind
      and (
        (jobs.status = 'queued' and jobs.available_at <= now())
        or (jobs.status = 'running' and jobs.lease_expires_at < now())
      )
    order by jobs.available_at, jobs.created_at
    for update skip locked
    limit greatest(1, least(claim_limit, 5))
  )
  update public.rd_jobs jobs
  set status = 'running',
      lease_owner = claim_worker,
      lease_expires_at = now() + make_interval(secs => greatest(120, claim_lease_seconds)),
      attempt_count = jobs.attempt_count + 1,
      last_error = null
  from candidates
  where jobs.id = candidates.id
  returning jobs.*;
end;
$$;

revoke all on function public.claim_rd_jobs_v3(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_rd_jobs_v3(text, text, integer, integer)
  to service_role;

comment on table public.rd_episode_outcomes_v3 is
  'First-open-clock, sensor-cadence episode totals for the shadow-only R&D pipeline.';
comment on function public.rd_episode_observation_v3(uuid) is
  'Episode-local telemetry backfill that remains permanently scoped to Matt control-pot evidence.';

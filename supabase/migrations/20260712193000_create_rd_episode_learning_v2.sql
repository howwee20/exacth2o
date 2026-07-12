-- Additive, shadow-only learning state for multi-pulse correction episodes.
-- This migration does not alter controller, command, pairing, calibration,
-- target, valve, sensor, group, or watering tables.

create table if not exists public.rd_episode_outcomes_v2 (
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
  actual_absolute jsonb not null,
  actual_delta jsonb not null,
  observed_horizons integer not null check (observed_horizons >= 0),
  pulse_count integer not null check (pulse_count > 0),
  eligible_for_scoring boolean not null default false,
  eligible_for_training boolean not null default false,
  quality_reasons jsonb not null default '[]'::jsonb,
  outcome_version text not null default 'episode-total-last-open-v1',
  completed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists rd_episode_outcomes_v2_training_idx
  on public.rd_episode_outcomes_v2
  (project_id, completed_at, pairing_name)
  where eligible_for_training = true;

create table if not exists public.rd_episode_scores_v2 (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null
    references public.rd_correction_episodes_v2(id) on delete restrict,
  outcome_id uuid not null
    references public.rd_episode_outcomes_v2(id) on delete restrict,
  model_version_id uuid not null
    references public.rd_model_versions(id) on delete restrict,
  model_role text not null check (model_role in ('baseline', 'candidate', 'champion')),
  curve_mae double precision,
  peak_error double precision,
  time_to_peak_error_minutes double precision,
  integrated_response_error double precision,
  interval_coverage double precision,
  scored_horizons integer not null check (scored_horizons >= 0),
  scoring_version text not null default 'episode-total-score-v1',
  created_at timestamptz not null default now(),
  unique (episode_id, model_version_id, scoring_version)
);

create index if not exists rd_episode_scores_v2_model_idx
  on public.rd_episode_scores_v2 (model_version_id, created_at desc);

create table if not exists public.rd_evaluation_windows_v2 (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null
    references public.rd_model_versions(id) on delete restrict,
  window_number integer not null check (window_number in (1, 2)),
  train_ended_at timestamptz not null,
  evaluation_started_at timestamptz not null,
  evaluation_ended_at timestamptz not null,
  episode_count integer not null check (episode_count > 0),
  multi_pulse_episode_count integer not null check (multi_pulse_episode_count >= 0),
  pot_count integer not null check (pot_count > 0),
  baseline_curve_mae double precision,
  candidate_curve_mae double precision,
  improvement_percent double precision,
  interval_coverage double precision,
  passed boolean not null default false,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (model_version_id, window_number)
);

create table if not exists public.rd_event_attributions_v2 (
  id uuid primary key default gen_random_uuid(),
  irrigation_event_id uuid not null
    references public.rd_irrigation_events_v2(id) on delete restrict,
  model_version_id uuid not null
    references public.rd_model_versions(id) on delete restrict,
  p10 jsonb not null,
  p50 jsonb not null,
  p90 jsonb not null,
  label_type text not null default 'model_attribution'
    check (label_type = 'model_attribution'),
  created_at timestamptz not null default now(),
  unique (irrigation_event_id, model_version_id)
);

create unique index if not exists rd_single_champion_model_idx
  on public.rd_model_versions ((status)) where status = 'champion';

alter table public.rd_episode_outcomes_v2 enable row level security;
alter table public.rd_episode_scores_v2 enable row level security;
alter table public.rd_evaluation_windows_v2 enable row level security;
alter table public.rd_event_attributions_v2 enable row level security;

revoke all on table public.rd_episode_outcomes_v2 from public, anon, authenticated;
revoke all on table public.rd_episode_scores_v2 from public, anon, authenticated;
revoke all on table public.rd_evaluation_windows_v2 from public, anon, authenticated;
revoke all on table public.rd_event_attributions_v2 from public, anon, authenticated;
grant select, insert on table public.rd_episode_outcomes_v2 to service_role;
grant select, insert on table public.rd_episode_scores_v2 to service_role;
grant select, insert on table public.rd_evaluation_windows_v2 to service_role;
grant select, insert on table public.rd_event_attributions_v2 to service_role;

drop trigger if exists rd_immutable_guard on public.rd_episode_outcomes_v2;
create trigger rd_immutable_guard before update or delete
on public.rd_episode_outcomes_v2 for each row
execute function public.rd_block_immutable_mutation();

drop trigger if exists rd_immutable_guard on public.rd_episode_scores_v2;
create trigger rd_immutable_guard before update or delete
on public.rd_episode_scores_v2 for each row
execute function public.rd_block_immutable_mutation();

drop trigger if exists rd_immutable_guard on public.rd_evaluation_windows_v2;
create trigger rd_immutable_guard before update or delete
on public.rd_evaluation_windows_v2 for each row
execute function public.rd_block_immutable_mutation();

drop trigger if exists rd_immutable_guard on public.rd_event_attributions_v2;
create trigger rd_immutable_guard before update or delete
on public.rd_event_attributions_v2 for each row
execute function public.rd_block_immutable_mutation();

create or replace function public.rd_promote_model_v2(
  promote_project_id uuid,
  promote_model_version_id uuid,
  promote_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate public.rd_model_versions%rowtype;
  previous_id uuid;
  qualified_windows integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may promote an R&D model';
  end if;

  perform pg_advisory_xact_lock(hashtext('exacth2o-rd-model-promotion-v2'));
  select * into candidate from public.rd_model_versions
  where id = promote_model_version_id and status = 'candidate'
    and synthetic_data_only = false
  for update;
  if not found then
    raise exception 'Promotion candidate is missing or not eligible';
  end if;

  select count(*) into qualified_windows
  from public.rd_evaluation_windows_v2
  where model_version_id = promote_model_version_id and passed = true;
  if qualified_windows < 2 then
    raise exception 'Two qualified chronological windows are required';
  end if;

  select id into previous_id from public.rd_model_versions
  where status = 'champion' limit 1 for update;
  if previous_id is not null then
    update public.rd_model_versions set status = 'retired' where id = previous_id;
  end if;
  update public.rd_model_versions set status = 'champion'
  where id = promote_model_version_id;

  insert into public.rd_model_promotions (
    project_id, model_version_id, previous_model_version_id,
    decision, evidence, actor_id
  ) values (
    promote_project_id, promote_model_version_id, previous_id,
    'promoted', coalesce(promote_evidence, '{}'::jsonb), null
  );

  return jsonb_build_object(
    'promoted', true,
    'model_version_id', promote_model_version_id,
    'previous_model_version_id', previous_id
  );
end;
$$;

revoke all on function public.rd_promote_model_v2(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.rd_promote_model_v2(uuid, uuid, jsonb)
  to service_role;

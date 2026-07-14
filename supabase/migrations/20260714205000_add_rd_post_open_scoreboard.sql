-- Add an immutable, post-open-only scientific scoreboard for V5 challengers.
-- This migration does not read or write controller commands, pairings, targets,
-- calibrations, valves, groups, watering behavior, portal auth, or researcher roles.

create table if not exists public.rd_post_open_scores_v5 (
  id uuid primary key default gen_random_uuid(),
  candidate_model_version_id uuid not null
    references public.rd_model_versions(id) on delete restrict,
  champion_model_version_id uuid not null
    references public.rd_model_versions(id) on delete restrict,
  source_prediction_id uuid not null
    references public.rd_curve_predictions(id) on delete restrict,
  irrigation_event_id uuid not null
    references public.rd_irrigation_events_v2(id) on delete restrict,
  event_finalization_id uuid not null
    references public.rd_event_finalizations_v5(id) on delete restrict,
  pairing_name text not null,
  opened_device_at timestamptz not null,
  pulse_sequence_in_episode integer not null check (pulse_sequence_in_episode > 0),
  outcome_evidence_fingerprint text not null,
  observation_fingerprint text not null,
  observation_max_server_received_at timestamptz,
  maturity text not null check (maturity = 'final'),
  evaluation_mode text not null
    check (evaluation_mode = 'frozen_model_causal_feature_replay'),
  candidate_curve_mae double precision,
  champion_curve_mae double precision,
  zero_curve_mae double precision,
  candidate_signed_bias double precision,
  champion_signed_bias double precision,
  zero_signed_bias double precision,
  interval_coverage double precision,
  scored_horizons integer not null check (scored_horizons > 0),
  continuous_candidate_curve_mae double precision,
  continuous_champion_curve_mae double precision,
  continuous_zero_curve_mae double precision,
  continuous_candidate_signed_bias double precision,
  continuous_champion_signed_bias double precision,
  continuous_zero_signed_bias double precision,
  continuous_interval_coverage double precision,
  continuous_scored_readings integer not null default 0
    check (continuous_scored_readings >= 0),
  ood_score double precision not null default 0 check (ood_score >= 0),
  scoring_version text not null default 'post-open-continuous-v1'
    check (scoring_version = 'post-open-continuous-v1'),
  created_at timestamptz not null default now(),
  unique (
    candidate_model_version_id, irrigation_event_id, event_finalization_id,
    observation_fingerprint
  )
);

create index if not exists rd_post_open_scores_v5_candidate_time_idx
  on public.rd_post_open_scores_v5
  (candidate_model_version_id, opened_device_at, pairing_name);

alter table public.rd_post_open_scores_v5 enable row level security;
revoke all on table public.rd_post_open_scores_v5 from public, anon, authenticated;
grant select, insert on table public.rd_post_open_scores_v5 to service_role;

drop trigger if exists rd_immutable_guard on public.rd_post_open_scores_v5;
create trigger rd_immutable_guard
  before update or delete on public.rd_post_open_scores_v5
  for each row execute function public.rd_block_immutable_mutation();

comment on table public.rd_post_open_scores_v5 is
  'Private final-maturity shadow scores excluding the pre-open baseline anchor; no actuation path.';

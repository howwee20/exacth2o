-- Additive, private V5 finalized-evidence and shadow-challenger lifecycle.
-- This migration has no controller, command, pairing, calibration, target,
-- group, sensor, valve, watering, portal-auth, or researcher-policy writes.

create table if not exists public.rd_event_finalizations_v5 (
  id uuid primary key default gen_random_uuid(),
  irrigation_event_id uuid not null
    references public.rd_irrigation_events_v2(id) on delete restrict,
  project_id uuid not null,
  device_id text not null,
  pairing_name text not null,
  opened_device_at timestamptz not null,
  feature_hash text not null,
  evidence_fingerprint text not null,
  finalization_revision integer not null check (finalization_revision > 0),
  supersedes_finalization_id uuid
    references public.rd_event_finalizations_v5(id) on delete restrict,
  finalization_reason text not null
    check (finalization_reason in ('next_pulse', 'full_horizon')),
  terminal_device_at timestamptz not null,
  horizon_manifest jsonb not null check (jsonb_typeof(horizon_manifest) = 'array'),
  observed_horizons integer not null check (observed_horizons >= 3),
  censored_horizons integer not null check (censored_horizons >= 0),
  duration_source text not null
    check (duration_source in ('observed_event', 'configured_snapshot', 'unknown')),
  quality jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (irrigation_event_id, finalization_revision),
  unique (irrigation_event_id, evidence_fingerprint)
);

create index if not exists rd_event_finalizations_v5_project_time_idx
  on public.rd_event_finalizations_v5
  (project_id, pairing_name, opened_device_at, finalization_revision desc);

create table if not exists public.rd_model_updates_v5 (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null unique
    references public.rd_model_versions(id) on delete restrict,
  previous_model_version_id uuid
    references public.rd_model_versions(id) on delete restrict,
  evidence_fingerprint text not null unique,
  training_event_count integer not null check (training_event_count >= 40),
  training_horizon_count integer not null check (training_horizon_count >= 120),
  dataset_manifest jsonb not null check (jsonb_typeof(dataset_manifest) = 'array'),
  artifact_path text not null check (artifact_path like 'gs://%'),
  artifact_sha256 text not null,
  code_commit text not null check (length(code_commit) >= 7 and code_commit <> 'unknown'),
  parameters jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.rd_shadow_model_channels_v5 (
  project_id uuid not null,
  device_id text not null,
  champion_model_version_id uuid not null
    references public.rd_model_versions(id) on delete restrict,
  evaluation_candidate_model_version_id uuid
    references public.rd_model_versions(id) on delete restrict,
  latest_challenger_model_version_id uuid
    references public.rd_model_versions(id) on delete restrict,
  champion_since timestamptz not null default now(),
  evaluation_started_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id),
  check (
    evaluation_candidate_model_version_id is null
    or evaluation_started_at is not null
  )
);

create table if not exists public.rd_shadow_model_channel_events_v5 (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  device_id text not null,
  event_type text not null check (
    event_type in ('champion_pinned', 'challenger_published', 'shadow_promoted')
  ),
  model_version_id uuid not null
    references public.rd_model_versions(id) on delete restrict,
  previous_model_version_id uuid
    references public.rd_model_versions(id) on delete restrict,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.rd_prequential_scores_v5 (
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
  duration_source text not null
    check (duration_source in ('observed_event', 'configured_snapshot', 'unknown')),
  pulse_sequence_in_episode integer not null check (pulse_sequence_in_episode > 0),
  outcome_evidence_fingerprint text not null,
  maturity text not null check (maturity = 'final'),
  evaluation_mode text not null
    check (evaluation_mode = 'frozen_model_causal_feature_replay'),
  curve_mae double precision,
  peak_error double precision,
  time_to_peak_error_minutes double precision,
  integrated_response_error double precision,
  interval_coverage double precision,
  scored_horizons integer not null check (scored_horizons > 0),
  scoring_version text not null default 'response-curve-v1',
  champion_curve_mae double precision,
  zero_curve_mae double precision,
  ood_score double precision not null default 0 check (ood_score >= 0),
  created_at timestamptz not null default now(),
  unique (
    candidate_model_version_id, irrigation_event_id, event_finalization_id
  )
);

create index if not exists rd_prequential_scores_v5_candidate_time_idx
  on public.rd_prequential_scores_v5
  (candidate_model_version_id, opened_device_at, pairing_name);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'rd_event_finalizations_v5', 'rd_model_updates_v5',
    'rd_shadow_model_channels_v5', 'rd_shadow_model_channel_events_v5',
    'rd_prequential_scores_v5'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'revoke all on table public.%I from public, anon, authenticated', table_name
    );
    execute format('grant select, insert on table public.%I to service_role', table_name);
  end loop;
end $$;

grant update on table public.rd_shadow_model_channels_v5 to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'rd_event_finalizations_v5', 'rd_model_updates_v5',
    'rd_shadow_model_channel_events_v5', 'rd_prequential_scores_v5'
  ] loop
    execute format('drop trigger if exists rd_immutable_guard on public.%I', table_name);
    execute format(
      'create trigger rd_immutable_guard before update or delete on public.%I '
      'for each row execute function public.rd_block_immutable_mutation()',
      table_name
    );
  end loop;
end $$;

do $$
declare
  pinned_model_id uuid;
begin
  select id into pinned_model_id
  from public.rd_model_versions
  where feature_schema_version = 'atomic-response-v4'
    and synthetic_data_only = false
  order by created_at desc
  limit 1;
  if pinned_model_id is not null then
    insert into public.rd_shadow_model_channels_v5 (
      project_id, device_id, champion_model_version_id
    ) values (
      '22222222-2222-4222-8222-222222222222'::uuid,
      '3100e37ee3205651fe3dd86dafd4dc0c',
      pinned_model_id
    ) on conflict (project_id, device_id) do nothing;
    if found then
      insert into public.rd_shadow_model_channel_events_v5 (
        project_id, device_id, event_type, model_version_id, evidence
      ) values (
        '22222222-2222-4222-8222-222222222222'::uuid,
        '3100e37ee3205651fe3dd86dafd4dc0c',
        'champion_pinned', pinned_model_id,
        jsonb_build_object(
          'reason', 'v5_initialization_pins_existing_v4_shadow_model',
          'shadow_only', true,
          'control_access', 'none'
        )
      );
    end if;
  end if;
end $$;

create or replace function public.rd_publish_v5_challenger(
  publish_version text,
  publish_artifact_path text,
  publish_artifact_sha256 text,
  publish_evidence_fingerprint text,
  publish_training_event_count integer,
  publish_training_horizon_count integer,
  publish_metrics jsonb,
  publish_parameters jsonb,
  publish_dataset_manifest jsonb,
  publish_code_commit text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prior_model_id uuid;
  created_model_id uuid;
  existing_model_id uuid;
  channel_record public.rd_shadow_model_channels_v5%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may publish private V5 challengers';
  end if;
  if publish_training_event_count < 40 or publish_training_horizon_count < 120 then
    raise exception 'V5 finalized-evidence readiness gate failed';
  end if;
  if jsonb_typeof(publish_dataset_manifest) <> 'array'
     or jsonb_array_length(publish_dataset_manifest) <> publish_training_event_count then
    raise exception 'V5 dataset manifest must identify every finalized training event';
  end if;
  if publish_code_commit = 'unknown' or length(publish_code_commit) < 7 then
    raise exception 'V5 publication requires a traceable code commit';
  end if;

  perform pg_advisory_xact_lock(hashtext('exacth2o-rd-v5-publication'));
  select model_version_id into existing_model_id
  from public.rd_model_updates_v5
  where evidence_fingerprint = publish_evidence_fingerprint;
  if found then
    select * into channel_record
    from public.rd_shadow_model_channels_v5
    where project_id = '22222222-2222-4222-8222-222222222222'::uuid
      and device_id = '3100e37ee3205651fe3dd86dafd4dc0c';
    return jsonb_build_object(
      'published', false,
      'model_version_id', existing_model_id,
      'champion_model_version_id', channel_record.champion_model_version_id,
      'evaluation_candidate_model_version_id',
        channel_record.evaluation_candidate_model_version_id
    );
  end if;

  select model_version_id into prior_model_id
  from public.rd_model_updates_v5 order by created_at desc limit 1;
  insert into public.rd_model_versions (
    version, status, artifact_path, artifact_sha256, feature_schema_version,
    training_dataset_hash, training_event_count, metrics, synthetic_data_only
  ) values (
    publish_version, 'candidate', publish_artifact_path, publish_artifact_sha256,
    'atomic-response-v5', publish_evidence_fingerprint,
    publish_training_event_count, publish_metrics, false
  ) returning id into created_model_id;
  insert into public.rd_model_updates_v5 (
    model_version_id, previous_model_version_id, evidence_fingerprint,
    training_event_count, training_horizon_count, dataset_manifest,
    artifact_path, artifact_sha256, code_commit, parameters, metrics
  ) values (
    created_model_id, prior_model_id, publish_evidence_fingerprint,
    publish_training_event_count, publish_training_horizon_count,
    publish_dataset_manifest, publish_artifact_path, publish_artifact_sha256,
    publish_code_commit, publish_parameters, publish_metrics
  );

  select * into channel_record
  from public.rd_shadow_model_channels_v5
  where project_id = '22222222-2222-4222-8222-222222222222'::uuid
    and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
  for update;
  if not found then
    raise exception 'V5 shadow channel was not initialized with a V4 champion';
  end if;
  update public.rd_shadow_model_channels_v5
  set latest_challenger_model_version_id = created_model_id,
      evaluation_candidate_model_version_id = coalesce(
        evaluation_candidate_model_version_id, created_model_id
      ),
      evaluation_started_at = case
        when evaluation_candidate_model_version_id is null then now()
        else evaluation_started_at
      end,
      updated_at = now()
  where project_id = channel_record.project_id and device_id = channel_record.device_id
  returning * into channel_record;
  insert into public.rd_shadow_model_channel_events_v5 (
    project_id, device_id, event_type, model_version_id,
    previous_model_version_id, evidence
  ) values (
    channel_record.project_id, channel_record.device_id, 'challenger_published',
    created_model_id, prior_model_id,
    jsonb_build_object(
      'evidence_fingerprint', publish_evidence_fingerprint,
      'training_event_count', publish_training_event_count,
      'shadow_only', true,
      'control_access', 'none'
    )
  );
  return jsonb_build_object(
    'published', true,
    'model_version_id', created_model_id,
    'champion_model_version_id', channel_record.champion_model_version_id,
    'evaluation_candidate_model_version_id',
      channel_record.evaluation_candidate_model_version_id
  );
end;
$$;

revoke all on function public.rd_publish_v5_challenger(
  text, text, text, text, integer, integer, jsonb, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.rd_publish_v5_challenger(
  text, text, text, text, integer, integer, jsonb, jsonb, jsonb, text
) to service_role;

create or replace function public.rd_promote_v5_shadow_candidate(
  promote_project_id uuid,
  promote_device_id text,
  promote_model_version_id uuid,
  promote_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  channel_record public.rd_shadow_model_channels_v5%rowtype;
  prior_champion uuid;
  next_candidate uuid;
  window_passes jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may promote a V5 shadow model';
  end if;
  if coalesce((promote_evidence ->> 'future_finalized_events')::integer, 0) < 40
     or coalesce((promote_evidence ->> 'calendar_span_days')::double precision, 0) < 3
     or coalesce((promote_evidence ->> 'pot_count')::integer, 0) < 8
     or coalesce((promote_evidence ->> 'multi_pulse_events')::integer, 0) < 10
     or coalesce(
          (promote_evidence ->> 'multi_pulse_curve_mae')::double precision, 1e9
        ) > 0.85 * coalesce(
          (promote_evidence ->> 'multi_pulse_champion_curve_mae')::double precision, 0
        )
     or (
       coalesce((promote_evidence ->> 'single_pulse_events')::integer, 0) > 0
       and coalesce(
         (promote_evidence ->> 'single_pulse_curve_mae')::double precision, 1e9
       ) > 1.05 * coalesce(
         (promote_evidence ->> 'single_pulse_champion_curve_mae')::double precision, 0
       )
     )
     or coalesce((promote_evidence ->> 'per_pot_regression')::boolean, true)
     or coalesce((promote_evidence ->> 'interval_coverage')::double precision, 0) < 0.75
     or coalesce((promote_evidence ->> 'interval_coverage')::double precision, 1) > 0.90
     or coalesce((promote_evidence ->> 'candidate_curve_mae')::double precision, 1e9)
        > 0.90 * coalesce(
          (promote_evidence ->> 'champion_curve_mae')::double precision, 0
        ) then
    raise exception 'V5 future prequential promotion evidence is insufficient';
  end if;
  window_passes := promote_evidence -> 'two_window_passes';
  if jsonb_typeof(window_passes) <> 'array'
     or jsonb_array_length(window_passes) <> 2
     or window_passes <> '[true, true]'::jsonb then
    raise exception 'V5 requires two independently passing chronological windows';
  end if;

  perform pg_advisory_xact_lock(hashtext('exacth2o-rd-v5-shadow-promotion'));
  select * into channel_record
  from public.rd_shadow_model_channels_v5
  where project_id = promote_project_id and device_id = promote_device_id
  for update;
  if not found
     or channel_record.evaluation_candidate_model_version_id
        is distinct from promote_model_version_id then
    raise exception 'Requested model is not the pinned V5 evaluation candidate';
  end if;
  prior_champion := channel_record.champion_model_version_id;
  next_candidate := case
    when channel_record.latest_challenger_model_version_id
         is distinct from promote_model_version_id
      then channel_record.latest_challenger_model_version_id
    else null
  end;
  update public.rd_shadow_model_channels_v5
  set champion_model_version_id = promote_model_version_id,
      champion_since = now(),
      evaluation_candidate_model_version_id = next_candidate,
      evaluation_started_at = case when next_candidate is null then null else now() end,
      updated_at = now()
  where project_id = promote_project_id and device_id = promote_device_id;
  insert into public.rd_shadow_model_channel_events_v5 (
    project_id, device_id, event_type, model_version_id,
    previous_model_version_id, evidence
  ) values (
    promote_project_id, promote_device_id, 'shadow_promoted',
    promote_model_version_id, prior_champion, promote_evidence
  );
  return jsonb_build_object(
    'promoted', true,
    'previous_champion_model_version_id', prior_champion,
    'champion_model_version_id', promote_model_version_id,
    'evaluation_candidate_model_version_id', next_candidate,
    'shadow_only', true,
    'control_access', 'none'
  );
end;
$$;

revoke all on function public.rd_promote_v5_shadow_candidate(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.rd_promote_v5_shadow_candidate(uuid, text, uuid, jsonb)
  to service_role;

comment on table public.rd_event_finalizations_v5 is
  'Private immutable finalized event manifests for V5 training; no control path.';
comment on table public.rd_shadow_model_channels_v5 is
  'Private pinned shadow champion and future-only V5 evaluation channel.';
comment on table public.rd_prequential_scores_v5 is
  'Private final-only scores for a model frozen before the evaluated event.';

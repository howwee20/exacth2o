-- Additive, shadow-only v4 scientific ledger and provisional model lineage.
-- This migration has no controller, command, pairing, calibration, target,
-- group, sensor, valve, watering, portal UI, auth, or researcher-policy writes.

create table if not exists public.rd_feature_snapshots_v4 (
  id uuid primary key default gen_random_uuid(),
  irrigation_event_id uuid not null unique
    references public.rd_irrigation_events_v2(id) on delete restrict,
  project_id uuid not null,
  device_id text not null,
  pairing_name text not null,
  opened_device_at timestamptz not null,
  feature_as_of_device_at timestamptz not null,
  latest_reading_id bigint,
  latest_reading_device_at timestamptz,
  feature_hash text not null,
  features jsonb not null,
  source text not null check (source = 'causal_pre_open_reconstruction_v4'),
  quality jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (feature_as_of_device_at = opened_device_at),
  check (latest_reading_device_at is null or latest_reading_device_at < opened_device_at)
);

create index if not exists rd_feature_snapshots_v4_time_idx
  on public.rd_feature_snapshots_v4
  (project_id, pairing_name, opened_device_at, irrigation_event_id);

create table if not exists public.rd_event_exclusions_v4 (
  id uuid primary key default gen_random_uuid(),
  irrigation_event_id uuid not null unique
    references public.rd_irrigation_events_v2(id) on delete restrict,
  reason text not null check (
    reason in ('no_verified_pre_open_reading', 'stale_pre_open_reading')
  ),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.rd_response_horizons_v4 (
  id uuid primary key default gen_random_uuid(),
  irrigation_event_id uuid not null
    references public.rd_irrigation_events_v2(id) on delete restrict,
  horizon_minute integer not null
    check (horizon_minute in (0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240)),
  target_device_at timestamptz not null,
  state text not null
    check (state in ('observed', 'right_censored', 'missing_reading')),
  baseline_reading_id bigint not null,
  baseline_device_at timestamptz not null,
  baseline_vwc double precision not null,
  outcome_reading_id bigint,
  outcome_device_at timestamptz,
  outcome_vwc double precision,
  actual_delta double precision,
  censor_device_at timestamptz,
  evidence_revision integer not null check (evidence_revision > 0),
  supersedes_horizon_id uuid
    references public.rd_response_horizons_v4(id) on delete restrict,
  evidence_hash text not null,
  quality jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (irrigation_event_id, horizon_minute, evidence_revision),
  unique (irrigation_event_id, horizon_minute, evidence_hash),
  check (
    (state = 'observed' and outcome_reading_id is not null
      and outcome_device_at is not null and outcome_vwc is not null
      and actual_delta is not null and censor_device_at is null)
    or
    (state = 'right_censored' and outcome_reading_id is null
      and outcome_device_at is null and outcome_vwc is null
      and actual_delta is null and censor_device_at is not null)
    or
    (state = 'missing_reading' and outcome_reading_id is null
      and outcome_device_at is null and outcome_vwc is null
      and actual_delta is null and censor_device_at is null)
  )
);

create index if not exists rd_response_horizons_v4_latest_idx
  on public.rd_response_horizons_v4
  (irrigation_event_id, horizon_minute, evidence_revision desc);

create table if not exists public.rd_model_updates_v4 (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null unique
    references public.rd_model_versions(id) on delete restrict,
  previous_model_version_id uuid
    references public.rd_model_versions(id) on delete restrict,
  evidence_fingerprint text not null unique,
  training_event_count integer not null check (training_event_count > 0),
  training_horizon_count integer not null check (training_horizon_count > 0),
  artifact_path text not null check (artifact_path like 'gs://%'),
  artifact_sha256 text not null,
  code_commit text not null,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.rd_response_scores_v4 (
  id uuid primary key default gen_random_uuid(),
  irrigation_event_id uuid not null
    references public.rd_irrigation_events_v2(id) on delete restrict,
  prediction_id uuid not null
    references public.rd_curve_predictions(id) on delete restrict,
  model_version_id uuid not null
    references public.rd_model_versions(id) on delete restrict,
  horizon_evidence_hash text not null,
  curve_mae double precision,
  peak_error double precision,
  time_to_peak_error_minutes double precision,
  integrated_response_error double precision,
  interval_coverage double precision,
  scored_horizons integer not null check (scored_horizons > 0),
  scoring_version text not null default 'atomic-response-v4',
  created_at timestamptz not null default now(),
  unique (irrigation_event_id, prediction_id, horizon_evidence_hash, scoring_version)
);

create unique index if not exists rd_one_provisional_atomic_v4_idx
  on public.rd_model_versions ((feature_schema_version))
  where feature_schema_version = 'atomic-response-v4' and status = 'candidate';

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'rd_feature_snapshots_v4', 'rd_event_exclusions_v4', 'rd_response_horizons_v4',
    'rd_model_updates_v4', 'rd_response_scores_v4'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'revoke all on table public.%I from public, anon, authenticated', table_name
    );
    execute format('grant select, insert on table public.%I to service_role', table_name);
    execute format('drop trigger if exists rd_immutable_guard on public.%I', table_name);
    execute format(
      'create trigger rd_immutable_guard before update or delete on public.%I '
      'for each row execute function public.rd_block_immutable_mutation()',
      table_name
    );
  end loop;
end $$;

create or replace function public.rd_training_evidence_page_v4(
  evidence_kind text,
  cursor_device_at timestamptz default null,
  cursor_event_id text default '',
  page_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  bounded_limit integer := greatest(1, least(coalesce(page_limit, 500), 500));
  control_pairings constant text[] := array[
    'Zone2-Pot41', 'Zone2-Pot43', 'Zone2-Pot45', 'Zone2-Pot47', 'Zone2-Pot49',
    'Zone4-Pot91', 'Zone4-Pot93', 'Zone4-Pot95', 'Zone4-Pot97', 'Zone4-Pot99'
  ];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may page private R&D evidence';
  end if;
  if evidence_kind not in ('reading', 'valve_open') then
    raise exception 'Unsupported R&D evidence kind';
  end if;

  if evidence_kind = 'reading' then
    select coalesce(jsonb_agg(to_jsonb(selected) order by selected.device_recorded_at,
      selected.event_id), '[]'::jsonb)
    into result
    from (
      select id, event_id, pairing_name, sensor_key, raw_value, calibrated_value,
             temperature, electrical_conductivity, device_recorded_at, server_received_at
      from public.sensor_readings
      where project_id = '22222222-2222-4222-8222-222222222222'::uuid
        and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
        and pairing_name = any(control_pairings)
        and event_id like 'live-device:%'
        and (
          cursor_device_at is null
          or device_recorded_at > cursor_device_at
          or (device_recorded_at = cursor_device_at and event_id > cursor_event_id)
        )
      order by device_recorded_at, event_id
      limit bounded_limit
    ) selected;
  else
    select coalesce(jsonb_agg(to_jsonb(selected) order by selected.device_recorded_at,
      selected.event_id), '[]'::jsonb)
    into result
    from (
      select event_id, pairing_name, action, duration_ms, device_recorded_at,
             server_received_at, evidence_source, source_class, pairing_resolved,
             quality_flags
      from public.valve_events
      where project_id = '22222222-2222-4222-8222-222222222222'::uuid
        and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
        and pairing_name = any(control_pairings)
        and action = 'open'
        and source_class = 'automatic'
        and pairing_resolved = true
        and (
          cursor_device_at is null
          or device_recorded_at > cursor_device_at
          or (device_recorded_at = cursor_device_at and event_id > cursor_event_id)
        )
      order by device_recorded_at, event_id
      limit bounded_limit
    ) selected;
  end if;
  return result;
end;
$$;

revoke all on function public.rd_training_evidence_page_v4(text, timestamptz, text, integer)
  from public, anon, authenticated;
grant execute on function public.rd_training_evidence_page_v4(text, timestamptz, text, integer)
  to service_role;

create or replace function public.rd_atomic_event_observation_v4(
  observation_irrigation_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_event public.rd_irrigation_events_v2%rowtype;
  result jsonb;
  control_pairings constant text[] := array[
    'Zone2-Pot41', 'Zone2-Pot43', 'Zone2-Pot45', 'Zone2-Pot47', 'Zone2-Pot49',
    'Zone4-Pot91', 'Zone4-Pot93', 'Zone4-Pot95', 'Zone4-Pot97', 'Zone4-Pot99'
  ];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may read private atomic R&D evidence';
  end if;
  select * into selected_event
  from public.rd_irrigation_events_v2
  where id = observation_irrigation_event_id
    and project_id = '22222222-2222-4222-8222-222222222222'::uuid
    and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
    and pairing_name = any(control_pairings);
  if not found then
    raise exception 'Approved control-pot irrigation event not found';
  end if;

  select jsonb_build_object(
    'irrigation_event_id', selected_event.id,
    'readings', coalesce((
      select jsonb_agg(to_jsonb(reading_row) order by reading_row.device_recorded_at,
        reading_row.event_id)
      from (
        select id, event_id, pairing_name, sensor_key, raw_value, calibrated_value,
               temperature, electrical_conductivity, device_recorded_at, server_received_at
        from public.sensor_readings
        where project_id = selected_event.project_id
          and device_id = selected_event.device_id
          and pairing_name = selected_event.pairing_name
          and event_id like 'live-device:%'
          and device_recorded_at >= selected_event.opened_device_at - interval '24 hours'
          and device_recorded_at <= selected_event.opened_device_at + interval '250 minutes'
        order by device_recorded_at, event_id
        limit 5000
      ) reading_row
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.rd_atomic_event_observation_v4(uuid)
  from public, anon, authenticated;
grant execute on function public.rd_atomic_event_observation_v4(uuid) to service_role;

create or replace function public.rd_publish_provisional_model_v4(
  publish_version text,
  publish_artifact_path text,
  publish_artifact_sha256 text,
  publish_evidence_fingerprint text,
  publish_training_event_count integer,
  publish_training_horizon_count integer,
  publish_metrics jsonb,
  publish_parameters jsonb,
  publish_code_commit text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_model_id uuid;
  previous_model_id uuid;
  created_model_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may publish a provisional R&D model';
  end if;
  if publish_artifact_path not like 'gs://%'
     or publish_training_event_count < 1
     or publish_training_horizon_count < 1 then
    raise exception 'Invalid provisional model evidence or artifact';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('exacth2o:atomic-response-v4:publish', 0));
  select id into existing_model_id
  from public.rd_model_versions
  where feature_schema_version = 'atomic-response-v4'
    and training_dataset_hash = publish_evidence_fingerprint
  order by created_at desc
  limit 1;
  if existing_model_id is not null then
    return jsonb_build_object(
      'published', false, 'reason', 'evidence_already_published',
      'model_version_id', existing_model_id
    );
  end if;

  select id into previous_model_id
  from public.rd_model_versions
  where feature_schema_version = 'atomic-response-v4'
    and status in ('candidate', 'champion')
  order by created_at desc
  limit 1
  for update;

  update public.rd_model_versions
  set status = 'retired'
  where feature_schema_version = 'atomic-response-v4' and status = 'candidate';

  insert into public.rd_model_versions (
    version, status, artifact_path, artifact_sha256, feature_schema_version,
    training_dataset_hash, training_event_count, metrics, synthetic_data_only
  ) values (
    publish_version, 'candidate', publish_artifact_path, publish_artifact_sha256,
    'atomic-response-v4', publish_evidence_fingerprint, publish_training_event_count,
    coalesce(publish_metrics, '{}'::jsonb) || jsonb_build_object(
      'role', 'provisional_living_model', 'shadow_only', true, 'control_access', 'none'
    ), false
  ) returning id into created_model_id;

  insert into public.rd_training_runs (
    model_version_id, code_commit, dataset_hash, parameters, training_event_count,
    held_out_event_count, result, metrics, completed_at
  ) values (
    created_model_id, publish_code_commit, publish_evidence_fingerprint,
    coalesce(publish_parameters, '{}'::jsonb), publish_training_event_count,
    coalesce((publish_metrics ->> 'held_out_event_count')::integer, 0),
    'succeeded', coalesce(publish_metrics, '{}'::jsonb), now()
  );

  insert into public.rd_model_updates_v4 (
    model_version_id, previous_model_version_id, evidence_fingerprint,
    training_event_count, training_horizon_count, artifact_path, artifact_sha256,
    code_commit, metrics
  ) values (
    created_model_id, previous_model_id, publish_evidence_fingerprint,
    publish_training_event_count, publish_training_horizon_count,
    publish_artifact_path, publish_artifact_sha256, publish_code_commit,
    coalesce(publish_metrics, '{}'::jsonb)
  );

  return jsonb_build_object(
    'published', true, 'model_version_id', created_model_id,
    'previous_model_version_id', previous_model_id
  );
end;
$$;

revoke all on function public.rd_publish_provisional_model_v4(
  text, text, text, text, integer, integer, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.rd_publish_provisional_model_v4(
  text, text, text, text, integer, integer, jsonb, jsonb, text
) to service_role;

comment on table public.rd_response_horizons_v4 is
  'Immutable per-pulse response evidence; each pulse is censored at the next pulse.';
comment on function public.rd_training_evidence_page_v4(text, timestamptz, text, integer) is
  'Deterministic keyset page over Matt control-pot evidence. Read-only and service-role only.';

-- Complete the private V5 three-register lifecycle:
-- champion is sticky, evaluation_candidate is the sole scored model, and
-- latest_challenger is a newest-only mailbox. Mature failed candidates may
-- advance only to a strictly newer challenger. Immature candidates continue
-- collecting future evidence. No controller or irrigation table is touched.

alter table public.rd_shadow_model_channel_events_v5
  drop constraint if exists rd_shadow_model_channel_events_v5_event_type_check;
alter table public.rd_shadow_model_channel_events_v5
  add constraint rd_shadow_model_channel_events_v5_event_type_check
  check (event_type in (
    'champion_pinned', 'challenger_published', 'shadow_promoted',
    'candidate_rejected', 'evaluation_bound'
  ));

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
  candidate_created_at timestamptz;
  candidate_hash text;
  score_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may promote a V5 shadow model';
  end if;
  if coalesce((promote_evidence ->> 'future_finalized_events')::integer, 0) < 40
     or coalesce((promote_evidence ->> 'calendar_span_days')::double precision, 0) < 3
     or coalesce((promote_evidence ->> 'pot_count')::integer, 0) < 8
     or coalesce((promote_evidence ->> 'first_pulse_pot_count')::integer, 0) < 8
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

  lock table public.rd_prequential_scores_v5 in share row exclusive mode;
  select count(*) into score_count
  from public.rd_prequential_scores_v5
  where candidate_model_version_id = promote_model_version_id;
  if score_count <> coalesce(
    (promote_evidence ->> 'raw_candidate_score_rows')::integer, -1
  ) then
    raise exception 'V5 promotion evidence changed during decision';
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

  select created_at, artifact_sha256
  into candidate_created_at, candidate_hash
  from public.rd_model_versions
  where id = promote_model_version_id
    and feature_schema_version = 'atomic-response-v5'
    and synthetic_data_only = false;
  if not found then
    raise exception 'Pinned V5 evaluation candidate is not eligible';
  end if;

  prior_champion := channel_record.champion_model_version_id;
  next_candidate := null;
  if channel_record.latest_challenger_model_version_id
     is distinct from promote_model_version_id then
    select id into next_candidate
    from public.rd_model_versions
    where id = channel_record.latest_challenger_model_version_id
      and id is distinct from prior_champion
      and status = 'candidate'
      and feature_schema_version = 'atomic-response-v5'
      and synthetic_data_only = false
      and created_at > candidate_created_at
      and artifact_sha256 is distinct from candidate_hash;
  end if;

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
  if next_candidate is not null then
    insert into public.rd_shadow_model_channel_events_v5 (
      project_id, device_id, event_type, model_version_id,
      previous_model_version_id, evidence
    ) values (
      promote_project_id, promote_device_id, 'evaluation_bound',
      next_candidate, promote_model_version_id,
      jsonb_build_object(
        'reason', 'newer_challenger_bound_after_shadow_promotion',
        'evaluation_clock_reset', true,
        'shadow_only', true,
        'control_access', 'none'
      )
    );
  end if;
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

create or replace function public.rd_reject_and_advance_v5_shadow_candidate(
  reject_project_id uuid,
  reject_device_id text,
  reject_model_version_id uuid,
  reject_expected_evaluation_started_at timestamptz,
  reject_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  channel_record public.rd_shadow_model_channels_v5%rowtype;
  candidate_created_at timestamptz;
  candidate_hash text;
  successor_id uuid;
  score_count integer;
  window_passes jsonb;
  is_promotable boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may reject private V5 challengers';
  end if;
  if coalesce((reject_evidence ->> 'future_finalized_events')::integer, 0) < 40
     or coalesce((reject_evidence ->> 'calendar_span_days')::double precision, 0) < 3
     or coalesce((reject_evidence ->> 'pot_count')::integer, 0) < 8
     or coalesce((reject_evidence ->> 'first_pulse_pot_count')::integer, 0) < 8
     or coalesce((reject_evidence ->> 'multi_pulse_events')::integer, 0) < 10 then
    raise exception 'V5 candidate is not mature enough for rejection';
  end if;

  window_passes := reject_evidence -> 'two_window_passes';
  is_promotable :=
    window_passes = '[true, true]'::jsonb
    and coalesce((reject_evidence ->> 'interval_coverage')::double precision, 0)
      between 0.75 and 0.90
    and not coalesce((reject_evidence ->> 'per_pot_regression')::boolean, true)
    and coalesce(
      (reject_evidence ->> 'candidate_curve_mae')::double precision, 1e9
    ) <= 0.90 * coalesce(
      (reject_evidence ->> 'champion_curve_mae')::double precision, 0
    )
    and coalesce(
      (reject_evidence ->> 'multi_pulse_curve_mae')::double precision, 1e9
    ) <= 0.85 * coalesce(
      (reject_evidence ->> 'multi_pulse_champion_curve_mae')::double precision, 0
    )
    and (
      coalesce((reject_evidence ->> 'single_pulse_events')::integer, 0) = 0
      or coalesce(
        (reject_evidence ->> 'single_pulse_curve_mae')::double precision, 1e9
      ) <= 1.05 * coalesce(
        (reject_evidence ->> 'single_pulse_champion_curve_mae')::double precision, 0
      )
    );
  if is_promotable then
    raise exception 'Refusing to reject a promotable V5 candidate';
  end if;

  lock table public.rd_prequential_scores_v5 in share row exclusive mode;
  perform pg_advisory_xact_lock(hashtext('exacth2o-rd-v5-shadow-promotion'));
  select * into channel_record
  from public.rd_shadow_model_channels_v5
  where project_id = reject_project_id and device_id = reject_device_id
  for update;
  if not found
     or channel_record.evaluation_candidate_model_version_id
        is distinct from reject_model_version_id
     or channel_record.evaluation_started_at
        is distinct from reject_expected_evaluation_started_at then
    return jsonb_build_object('advanced', false, 'reason', 'stale_evaluation_binding');
  end if;

  select count(*) into score_count
  from public.rd_prequential_scores_v5
  where candidate_model_version_id = reject_model_version_id;
  if score_count <> coalesce(
    (reject_evidence ->> 'raw_candidate_score_rows')::integer, -1
  ) then
    return jsonb_build_object('advanced', false, 'reason', 'evaluation_evidence_changed');
  end if;

  select created_at, artifact_sha256
  into candidate_created_at, candidate_hash
  from public.rd_model_versions
  where id = reject_model_version_id
    and status = 'candidate'
    and feature_schema_version = 'atomic-response-v5'
    and synthetic_data_only = false;
  if not found then
    return jsonb_build_object('advanced', false, 'reason', 'candidate_not_rejectable');
  end if;

  successor_id := null;
  select id into successor_id
  from public.rd_model_versions
  where id = channel_record.latest_challenger_model_version_id
    and id is distinct from reject_model_version_id
    and id is distinct from channel_record.champion_model_version_id
    and status = 'candidate'
    and feature_schema_version = 'atomic-response-v5'
    and synthetic_data_only = false
    and created_at > candidate_created_at
    and artifact_sha256 is distinct from candidate_hash;
  if successor_id is null then
    return jsonb_build_object('advanced', false, 'reason', 'no_eligible_newer_challenger');
  end if;

  update public.rd_model_versions
  set status = 'retired'
  where id = reject_model_version_id and status = 'candidate';
  update public.rd_shadow_model_channels_v5
  set evaluation_candidate_model_version_id = successor_id,
      evaluation_started_at = now(),
      updated_at = now()
  where project_id = reject_project_id and device_id = reject_device_id;

  insert into public.rd_shadow_model_channel_events_v5 (
    project_id, device_id, event_type, model_version_id,
    previous_model_version_id, evidence
  ) values (
    reject_project_id, reject_device_id, 'candidate_rejected',
    reject_model_version_id, channel_record.champion_model_version_id,
    reject_evidence || jsonb_build_object(
      'successor_model_version_id', successor_id,
      'evaluation_policy', 'expanding_window_until_newer_challenger',
      'shadow_only', true,
      'control_access', 'none'
    )
  );
  insert into public.rd_shadow_model_channel_events_v5 (
    project_id, device_id, event_type, model_version_id,
    previous_model_version_id, evidence
  ) values (
    reject_project_id, reject_device_id, 'evaluation_bound',
    successor_id, reject_model_version_id,
    jsonb_build_object(
      'reason', 'newer_challenger_bound_after_mature_rejection',
      'evaluation_clock_reset', true,
      'shadow_only', true,
      'control_access', 'none'
    )
  );
  return jsonb_build_object(
    'advanced', true,
    'rejected_model_version_id', reject_model_version_id,
    'evaluation_candidate_model_version_id', successor_id,
    'champion_model_version_id', channel_record.champion_model_version_id,
    'shadow_only', true,
    'control_access', 'none'
  );
end;
$$;

revoke all on function public.rd_reject_and_advance_v5_shadow_candidate(
  uuid, text, uuid, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.rd_reject_and_advance_v5_shadow_candidate(
  uuid, text, uuid, timestamptz, jsonb
) to service_role;

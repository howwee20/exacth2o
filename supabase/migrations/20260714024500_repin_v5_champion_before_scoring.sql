-- The final queued V4 job completed after V5 channel initialization. Re-pin
-- the baseline to that final V4 successor only while the V5 candidate still
-- has zero future prequential scores. The table lock makes the zero-score
-- check and channel update one atomic lifecycle transition.
-- This touches private R&D model metadata only.

do $$
declare
  channel_record public.rd_shadow_model_channels_v5%rowtype;
  latest_v4_model_id uuid;
  latest_v4_version text;
  score_count integer;
begin
  lock table public.rd_prequential_scores_v5 in share row exclusive mode;

  select * into channel_record
  from public.rd_shadow_model_channels_v5
  where project_id = '22222222-2222-4222-8222-222222222222'::uuid
    and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
  for update;

  if not found or channel_record.evaluation_candidate_model_version_id is null then
    return;
  end if;

  select id, version into latest_v4_model_id, latest_v4_version
  from public.rd_model_versions
  where feature_schema_version = 'atomic-response-v4'
    and synthetic_data_only = false
    and status = 'candidate'
  order by created_at desc, id desc
  limit 1;

  if latest_v4_model_id is null
     or latest_v4_model_id = channel_record.champion_model_version_id then
    return;
  end if;

  select count(*) into score_count
  from public.rd_prequential_scores_v5
  where candidate_model_version_id =
    channel_record.evaluation_candidate_model_version_id;

  if score_count <> 0 then
    raise exception
      'Refusing to change V5 champion after future prequential scoring began';
  end if;

  update public.rd_shadow_model_channels_v5
  set champion_model_version_id = latest_v4_model_id,
      champion_since = now(),
      evaluation_started_at = now(),
      updated_at = now()
  where project_id = channel_record.project_id
    and device_id = channel_record.device_id;

  insert into public.rd_shadow_model_channel_events_v5 (
    project_id, device_id, event_type, model_version_id,
    previous_model_version_id, evidence
  ) values (
    channel_record.project_id,
    channel_record.device_id,
    'champion_pinned',
    latest_v4_model_id,
    channel_record.champion_model_version_id,
    jsonb_build_object(
      'reason', 'final_queued_v4_successor_completed_before_any_v5_score',
      'version', latest_v4_version,
      'future_prequential_scores_at_repin', score_count,
      'evaluation_clock_reset', true,
      'shadow_only', true,
      'control_access', 'none'
    )
  );
end $$;

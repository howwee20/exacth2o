-- Training a private V5 challenger may begin with structural first-pulse
-- evidence from six control pots. Promotion remains stricter: the future
-- prequential evidence must include first pulses from at least eight pots.
-- This migration only tightens the private shadow-model promotion guard.

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

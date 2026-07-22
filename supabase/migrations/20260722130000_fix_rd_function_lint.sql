-- Preserve the existing R&D function behavior while removing plpgsql type and
-- unused-row warnings reported by `supabase db lint`.

create or replace function public.rd_worker_observation(
  observation_project_id uuid,
  observation_device_id text,
  observation_since timestamptz default now() - interval '36 hours'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  matt_project_id constant uuid := '22222222-2222-4222-8222-222222222222'::uuid;
  matt_device_id constant text := '3100e37ee3205651fe3dd86dafd4dc0c';
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may read the R&D worker observation';
  end if;
  if observation_project_id <> matt_project_id or observation_device_id <> matt_device_id then
    raise exception 'R&D observation is scoped to the approved shadow experiment';
  end if;
  if observation_since < now() - interval '8 days' then
    raise exception 'R&D observation window is too large';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'config', (
      select to_jsonb(config_row)
      from (
        select project_id, device_id, observed_at, pairings, calibrations,
               board_config, groups, config_hash, updated_at
        from public.device_config_state
        where project_id = matt_project_id and device_id = matt_device_id
        limit 1
      ) config_row
    ),
    'readings', coalesce((
      select jsonb_agg(to_jsonb(reading_row) order by reading_row.device_recorded_at)
      from (
        select id, event_id, pairing_name, sensor_key, raw_value,
               calibrated_value, temperature, electrical_conductivity,
               device_recorded_at, server_received_at
        from public.sensor_readings
        where project_id = matt_project_id
          and device_id = matt_device_id
          and device_recorded_at >= observation_since
          and event_id like 'live-device:%'
        order by device_recorded_at desc
        limit 12000
      ) reading_row
    ), '[]'::jsonb),
    'valve_events', coalesce((
      select jsonb_agg(to_jsonb(valve_row) order by valve_row.device_recorded_at)
      from (
        select event_id, pairing_name, action, duration_ms,
               device_recorded_at, server_received_at, evidence_source,
               source_class, pairing_resolved, quality_flags
        from public.valve_events
        where project_id = matt_project_id
          and device_id = matt_device_id
          and device_recorded_at >= observation_since
          and source_class = 'automatic'
          and pairing_resolved = true
        order by device_recorded_at desc
        limit 2000
      ) valve_row
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.rd_worker_observation(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.rd_worker_observation(uuid, text, timestamptz)
  to service_role;

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
  previous_id uuid;
  qualified_windows integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may promote an R&D model';
  end if;

  perform pg_advisory_xact_lock(hashtext('exacth2o-rd-model-promotion-v2'));
  perform 1 from public.rd_model_versions
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

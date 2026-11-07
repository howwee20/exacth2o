-- New installations can publish their own observed configuration without an
-- inbound network connection. Existing installation ingestion is unchanged.
create or replace function public.device_publish_configuration(device_token text, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  device public.devices%rowtype;
  cfg jsonb;
  system_state jsonb;
  section text;
  state text;
  cfg_hash text;
  seen timestamptz := clock_timestamp();
  preserve_configuration boolean := false;
begin
  if payload is null or jsonb_typeof(payload) <> 'object'
     or octet_length(payload::text) > 2097152 then
    raise exception 'Invalid configuration payload' using errcode='22023';
  end if;
  select d.* into device
  from public.devices d join public.device_secrets s on s.device_id=d.id
  where d.id=payload->>'device_id' and s.revoked_at is null
    and s.token_hash=encode(extensions.digest(coalesce(device_token,''),'sha256'),'hex');
  if not found then
    raise exception 'Invalid device token' using errcode='28000';
  end if;
  cfg := payload->'config';
  if jsonb_typeof(cfg) is distinct from 'object' then
    raise exception 'Complete configuration is required' using errcode='22023';
  end if;
  foreach section in array array['pairings','calibrations','board_config','sensors','valves','groups'] loop
    if jsonb_typeof(cfg->section) is distinct from 'array' then
      raise exception 'Invalid configuration section: %',section using errcode='22023';
    end if;
    if jsonb_array_length(cfg->section)>2000 then
      raise exception 'Configuration section is too large' using errcode='22023';
    end if;
  end loop;
  system_state := case when jsonb_typeof(payload->'system')='object' then payload->'system' else '{}'::jsonb end;
  state := upper(coalesce(system_state->>'state','UNKNOWN'));
  if state not in ('RUNNING','STOPPED','STARTUP','ERROR','UPDATE','RESET') then state := 'UNKNOWN'; end if;
  cfg_hash := encode(extensions.digest(cfg::text,'sha256'),'hex');

  -- An accidentally empty local database must not erase a previously observed
  -- populated configuration. Its old observation time remains visibly stale.
  select exists (
    select 1 from public.device_config_state c
    where c.project_id=device.project_id and c.device_id=device.id
      and c.pairing_count>0 and jsonb_array_length(cfg->'pairings')=0
      and jsonb_array_length(cfg->'sensors')=0 and jsonb_array_length(cfg->'valves')=0
  ) into preserve_configuration;
  if not preserve_configuration then
    insert into public.device_config_state (
      project_id,device_id,device_name,source,observed_at,pairings,calibrations,
      board_config,sensors,valves,groups,pairing_count,calibration_count,board_count,
      sensor_count,valve_count,group_count,config_hash,endpoint_status,raw_config,updated_at
    ) values (
      device.project_id,device.id,device.name,'device-push',seen,cfg->'pairings',cfg->'calibrations',
      cfg->'board_config',cfg->'sensors',cfg->'valves',cfg->'groups',
      jsonb_array_length(cfg->'pairings'),jsonb_array_length(cfg->'calibrations'),
      jsonb_array_length(cfg->'board_config'),jsonb_array_length(cfg->'sensors'),
      jsonb_array_length(cfg->'valves'),jsonb_array_length(cfg->'groups'),cfg_hash,
      coalesce(payload->'endpoint_status','{}'::jsonb),cfg,seen
    ) on conflict (project_id,device_id) do update set
      device_name=excluded.device_name,source=excluded.source,observed_at=excluded.observed_at,
      pairings=excluded.pairings,calibrations=excluded.calibrations,board_config=excluded.board_config,
      sensors=excluded.sensors,valves=excluded.valves,groups=excluded.groups,
      pairing_count=excluded.pairing_count,calibration_count=excluded.calibration_count,
      board_count=excluded.board_count,sensor_count=excluded.sensor_count,
      valve_count=excluded.valve_count,group_count=excluded.group_count,
      config_hash=excluded.config_hash,endpoint_status=excluded.endpoint_status,
      raw_config=excluded.raw_config,updated_at=excluded.updated_at;
  end if;
  insert into public.device_runtime_state (
    project_id,device_id,device_name,source,controller_state,controller_state_raw,
    state_observed_at,state_fresh_until,overall_status,api_status,pi_online,
    watering_enabled,watering_disabled,config_hash,raw_status,raw_health,raw_system,updated_at
  ) values (
    device.project_id,device.id,device.name,'device-push',state,system_state->>'state',
    seen,seen+interval '150 seconds',case when state='UNKNOWN' then 'warning' else 'ok' end,
    'ok',true,null,'[]'::jsonb,case when preserve_configuration then null else cfg_hash end,
    jsonb_build_object('source','device-push','api_reachable',true),'{}'::jsonb,system_state,seen
  ) on conflict (project_id,device_id) do update set
    device_name=excluded.device_name,source=excluded.source,controller_state=excluded.controller_state,
    controller_state_raw=excluded.controller_state_raw,state_observed_at=excluded.state_observed_at,
    state_fresh_until=excluded.state_fresh_until,overall_status=excluded.overall_status,
    api_status=excluded.api_status,pi_online=true,watering_enabled=null,watering_disabled=excluded.watering_disabled,
    config_hash=excluded.config_hash,raw_status=excluded.raw_status,
    raw_health=excluded.raw_health,raw_system=excluded.raw_system,updated_at=excluded.updated_at;
  update public.devices set status='online',last_seen_at=seen where id=device.id;
  insert into public.latest_device_state (
    device_id,organization_id,project_id,last_seen_at,health_status,latest_payload,updated_at
  ) values (
    device.id,device.organization_id,device.project_id,seen,'online',
    jsonb_build_object('source','device-push','controller_state',state,'config_updated',not preserve_configuration),seen
  ) on conflict (device_id) do update set last_seen_at=excluded.last_seen_at,
    health_status=excluded.health_status,latest_payload=excluded.latest_payload,updated_at=excluded.updated_at;
  return jsonb_build_object('ok',true,'project_id',device.project_id,'device_id',device.id,
    'config_updated',not preserve_configuration,'observed_at',seen);
end;
$$;
revoke all on function public.device_publish_configuration(text,jsonb) from public;
grant execute on function public.device_publish_configuration(text,jsonb) to anon,authenticated;

-- Disposable device authentication, scope and observation checks. No hardware.
begin;
do $$
declare
  org uuid := gen_random_uuid();
  project_a uuid := gen_random_uuid();
  project_b uuid := gen_random_uuid();
  device_a text := 'push-test-a-' || gen_random_uuid()::text;
  device_b text := 'push-test-b-' || gen_random_uuid()::text;
  token_a text := encode(extensions.gen_random_bytes(32),'hex');
  cfg jsonb := '{"pairings":[],"calibrations":[],"board_config":[],"sensors":[],"valves":[],"groups":[]}'::jsonb;
  message jsonb;
  answer jsonb;
  old_hash text;
begin
  insert into public.organizations(id,slug,name) values(org,'push-test-'||org::text,'Disposable push test');
  insert into public.projects(id,organization_id,slug,name) values
    (project_a,org,'push-a-'||project_a::text,'Push A'),
    (project_b,org,'push-b-'||project_b::text,'Push B');
  insert into public.devices(id,organization_id,project_id,name,status) values
    (device_a,org,project_a,'Push A','offline'),(device_b,org,project_b,'Push B','offline');
  insert into public.device_secrets(device_id,token_hash) values
    (device_a,encode(extensions.digest(token_a,'sha256'),'hex'));
  message := jsonb_build_object('device_id',device_a,'project_id',project_b,
    'config',cfg,'system',jsonb_build_object('state','STOPPED'));

  begin
    perform public.device_publish_configuration('invalid-token',message);
    raise exception 'An invalid token was accepted';
  exception when invalid_authorization_specification then null; end;
  begin
    perform public.device_publish_configuration(token_a,jsonb_set(message,'{device_id}',to_jsonb(device_b)));
    raise exception 'A token published another device';
  exception when invalid_authorization_specification then null; end;
  begin
    perform public.device_publish_configuration(token_a,message #- '{config,sensors}');
    raise exception 'An incomplete snapshot was accepted';
  exception when invalid_parameter_value then null; end;

  answer := public.device_publish_configuration(token_a,message);
  if answer->>'project_id' <> project_a::text or answer->>'device_id' <> device_a
     or (answer->>'config_updated')::boolean is not true then
    raise exception 'Server did not bind the snapshot to its authenticated device';
  end if;
  if not exists(select 1 from public.device_config_state where project_id=project_a and device_id=device_a and pairing_count=0)
     or not exists(select 1 from public.devices where id=device_a and status='online')
     or not exists(select 1 from public.latest_device_state where device_id=device_a and project_id=project_a and health_status='online')
     or not exists(select 1 from public.device_runtime_state where device_id=device_a and controller_state='STOPPED' and state_fresh_until>now()) then
    raise exception 'Complete empty first-boot observation was not recorded';
  end if;
  if exists(select 1 from public.device_config_state where device_id=device_b)
     or exists(select 1 from public.latest_device_state where device_id=device_b) then
    raise exception 'Snapshot escaped its authenticated device';
  end if;

  cfg := jsonb_set(cfg,'{pairings}','[{"name":"Fixture pot","sensorId":1,"valveId":1}]'::jsonb);
  cfg := jsonb_set(cfg,'{sensors}','[{"id":1}]'::jsonb);
  cfg := jsonb_set(cfg,'{valves}','[{"id":1}]'::jsonb);
  message := jsonb_set(message,'{config}',cfg);
  answer := public.device_publish_configuration(token_a,message);
  select config_hash into old_hash from public.device_config_state where device_id=device_a;
  if not exists(select 1 from public.device_config_state where device_id=device_a and pairing_count=1 and sensor_count=1 and valve_count=1) then
    raise exception 'Populated configuration counts are incorrect';
  end if;

  update public.device_runtime_state set watering_enabled=true where device_id=device_a;
  message := jsonb_set(message,'{system,state}','"unrecognized"'::jsonb);
  perform public.device_publish_configuration(token_a,message);
  if not exists(select 1 from public.device_runtime_state where device_id=device_a and controller_state='UNKNOWN' and watering_enabled is null) then
    raise exception 'Unknown runtime retained stale watering-enabled state';
  end if;
  message := jsonb_set(message,'{config}','{"pairings":[],"calibrations":[],"board_config":[],"sensors":[],"valves":[],"groups":[]}'::jsonb);
  answer := public.device_publish_configuration(token_a,message);
  if (answer->>'config_updated')::boolean is not false
     or not exists(select 1 from public.device_config_state where device_id=device_a and pairing_count=1 and config_hash=old_hash) then
    raise exception 'An accidental empty database erased the prior configuration';
  end if;

  update public.device_secrets set revoked_at=now() where device_id=device_a;
  begin
    perform public.device_publish_configuration(token_a,message);
    raise exception 'A revoked token was accepted';
  exception when invalid_authorization_specification then null; end;
  if exists(select 1 from public.sensor_readings where device_id in (device_a,device_b))
     or exists(select 1 from public.valve_events where device_id in (device_a,device_b)) then
    raise exception 'Configuration publication fabricated readings or valve events';
  end if;
  if not has_function_privilege('anon','public.device_publish_configuration(text,jsonb)','EXECUTE') then
    raise exception 'Device RPC is not callable with its scoped device token';
  end if;
  if exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid='public.device_publish_configuration(text,jsonb)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') then
    raise exception 'Device RPC grants execution to PUBLIC';
  end if;
end $$;
rollback;

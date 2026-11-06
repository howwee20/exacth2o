-- Transaction-only fixtures for agent wake-ups and attention. No device
-- receives a command: every row below is rolled back, and attention columns
-- never change readiness, command, revision or controller state.
begin;
do $$
declare
  u uuid := gen_random_uuid();
  stranger uuid := gen_random_uuid();
  invitation record;
  gas_project constant uuid := '44444444-4444-4444-8444-444444444441';
  gas_device constant text := 'gas-mixer:b827eb548a44';
  light_device constant text := 'lighting:beagle';
  first_attention timestamptz;
  second_attention timestamptz;
  before_state jsonb;
  after_state jsonb;
  snapshot jsonb;
  session_id uuid;
begin
  insert into auth.users(id, email) values (u, 'agent-wake-test@example.invalid'),
    (stranger, 'agent-wake-stranger@example.invalid');
  select * into invitation from public.create_gas_mixer_invite('agent-wake-test@example.invalid');
  update public.project_invites set accepted_at = now(), accepted_by = u where id = invitation.invite_id;

  -- Status reads keep their exact contract while recording one throttled attention write.
  update public.gas_mixer_native_device_state set agent_attention_until = null
    where project_id = gas_project and device_id = gas_device;
  select to_jsonb(s) - 'agent_attention_until' into before_state
    from public.gas_mixer_native_device_state s where device_id = gas_device;
  perform set_config('request.jwt.claim.sub', u::text, true);
  snapshot := public.gas_mixer_native_status(gas_project, gas_device);
  if not (snapshot ? 'bridge_ready' and snapshot ? 'state_revision' and snapshot ? 'last_command'
          and snapshot ? 'remote_control_allowed') or snapshot ? 'agent_attention_until' then
    raise exception 'Native status response shape changed: %', snapshot;
  end if;
  select agent_attention_until into first_attention
    from public.gas_mixer_native_device_state where device_id = gas_device;
  if first_attention is null or first_attention < now() + interval '35 seconds'
     or first_attention > now() + interval '45 seconds' then
    raise exception 'Viewer attention was not recorded: %', first_attention;
  end if;
  perform public.gas_mixer_native_status(gas_project, gas_device);
  select agent_attention_until into second_attention
    from public.gas_mixer_native_device_state where device_id = gas_device;
  if second_attention <> first_attention then
    raise exception 'Viewer attention was rewritten before the 15 s throttle';
  end if;
  select to_jsonb(s) - 'agent_attention_until' into after_state
    from public.gas_mixer_native_device_state s where device_id = gas_device;
  if after_state <> before_state then
    raise exception 'A status read changed controller state';
  end if;

  update public.lighting_device_state set agent_attention_until = null
    where project_id = gas_project and device_id = light_device;
  snapshot := public.lighting_native_status(gas_project, light_device);
  if snapshot->>'remote_control_allowed' <> 'true' or snapshot ? 'agent_attention_until' then
    raise exception 'Lighting status response changed: %', snapshot;
  end if;
  if (select agent_attention_until from public.lighting_device_state where device_id = light_device)
       is null then
    raise exception 'Lighting viewer attention was not recorded';
  end if;

  -- Unauthorized readers still fail before any write.
  update public.gas_mixer_native_device_state set agent_attention_until = null where device_id = gas_device;
  perform set_config('request.jwt.claim.sub', stranger::text, true);
  begin
    perform public.gas_mixer_native_status(gas_project, gas_device);
    raise exception 'Stranger could read native mixer status';
  exception when insufficient_privilege then null;
  end;
  if (select agent_attention_until from public.gas_mixer_native_device_state where device_id = gas_device)
       is not null then
    raise exception 'Unauthorized read recorded attention';
  end if;

  -- A durable command marks the agent attended for 60 s; nothing else changes.
  insert into public.gas_mixer_native_commands(project_id, device_id, requested_by, command_type,
      payload, expected_revision, idempotency_key)
    values (gas_project, gas_device, u, 'set_field', '{"field":"use_licor","value":true}', 1, gen_random_uuid());
  if (select agent_attention_until from public.gas_mixer_native_device_state where device_id = gas_device)
       < now() + interval '55 seconds' then
    raise exception 'Native command did not mark the bridge attended';
  end if;

  update public.lighting_device_state set agent_attention_until = null where device_id = light_device;
  insert into public.lighting_commands(project_id, device_id, requested_by, intensity,
      expected_revision, idempotency_key)
    values (gas_project, light_device, u, 120, 1, gen_random_uuid());
  if (select agent_attention_until from public.lighting_device_state where device_id = light_device)
       < now() + interval '55 seconds' then
    raise exception 'Lighting command did not mark the bridge attended';
  end if;

  -- Screen attention follows the newest active session and clears when it ends.
  update public.gas_mixer_device_status set agent_attention_until = null where device_id = gas_device;
  insert into public.gas_mixer_remote_sessions(project_id, device_id, user_id, mode, status, token_hash, expires_at)
    values (gas_project, gas_device, u, 'view', 'issued', encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'),
            now() + interval '4 minutes')
    returning id into session_id;
  if (select agent_attention_until from public.gas_mixer_device_status where device_id = gas_device)
       is distinct from (select expires_at from public.gas_mixer_remote_sessions where id = session_id) then
    raise exception 'Screen session did not mark the screen agent attended';
  end if;
  update public.gas_mixer_remote_sessions set status = 'ended', ended_at = now() where id = session_id;
  if (select agent_attention_until from public.gas_mixer_device_status where device_id = gas_device)
       is not null then
    raise exception 'Ended screen session left the agent attended';
  end if;
end;
$$;
rollback;

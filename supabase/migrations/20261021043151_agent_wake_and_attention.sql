-- Wake held chamber-agent requests the moment durable work or a viewer appears.
--
-- The command tables stay authoritative. A notification on channel
-- exacth2o_agent_wake carries only '<agent>:<device_id>'; agents re-read their
-- queue with the usual expiry, revision and status filters, so a lost,
-- duplicated or reordered notification can delay work but never create it.
-- agent_attention_until tells an agent when someone is waiting on it (a
-- recent command, an open screen session or a visible portal panel), so it
-- answers promptly then and holds its idle requests open otherwise.
-- Additive only: no stored command, state, experiment or controller row changes.
set lock_timeout = '2s';
set statement_timeout = '30s';

alter table public.gas_mixer_native_device_state
  add column if not exists agent_attention_until timestamptz;
alter table public.lighting_device_state
  add column if not exists agent_attention_until timestamptz;
alter table public.gas_mixer_device_status
  add column if not exists agent_attention_until timestamptz;

comment on column public.gas_mixer_native_device_state.agent_attention_until is
  'Until when the native bridge should answer promptly (recent command or visible portal panel). Not a readiness signal.';
comment on column public.lighting_device_state.agent_attention_until is
  'Until when the lighting bridge should answer promptly (recent command or visible portal panel). Not a readiness signal.';
comment on column public.gas_mixer_device_status.agent_attention_until is
  'Expiry of the newest active screen session; the screen agent holds idle requests only after it passes. Not a readiness signal.';

create or replace function public.agent_wake_on_native_command()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A wake-up is only a hint: never let it block the durable command.
  begin
    update public.gas_mixer_native_device_state state
    set agent_attention_until = greatest(
      coalesce(state.agent_attention_until, now()),
      now() + interval '60 seconds'
    )
    where state.project_id = new.project_id
      and state.device_id = new.device_id;
    perform pg_notify('exacth2o_agent_wake', 'native:' || new.device_id);
  exception when others then
    null;
  end;
  return null;
end;
$$;

create or replace function public.agent_wake_on_lighting_command()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    update public.lighting_device_state state
    set agent_attention_until = greatest(
      coalesce(state.agent_attention_until, now()),
      now() + interval '60 seconds'
    )
    where state.project_id = new.project_id
      and state.device_id = new.device_id;
    perform pg_notify('exacth2o_agent_wake', 'lighting:' || new.device_id);
  exception when others then
    null;
  end;
  return null;
end;
$$;

create or replace function public.agent_wake_on_screen_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_attention timestamptz;
begin
  begin
    if tg_table_name = 'gas_mixer_remote_sessions' then
      select max(session.expires_at)
      into session_attention
      from public.gas_mixer_remote_sessions session
      where session.project_id = new.project_id
        and session.device_id = new.device_id
        and session.status in ('issued', 'connected')
        and session.expires_at > now();

      update public.gas_mixer_device_status status
      set agent_attention_until = session_attention
      where status.project_id = new.project_id
        and status.device_id = new.device_id
        and status.agent_attention_until is distinct from session_attention;
    end if;
    perform pg_notify('exacth2o_agent_wake', 'screen:' || new.device_id);
  exception when others then
    null;
  end;
  return null;
end;
$$;

revoke all on function public.agent_wake_on_native_command() from public, anon, authenticated;
revoke all on function public.agent_wake_on_lighting_command() from public, anon, authenticated;
revoke all on function public.agent_wake_on_screen_activity() from public, anon, authenticated;

drop trigger if exists agent_wake_native_command on public.gas_mixer_native_commands;
create trigger agent_wake_native_command
after insert on public.gas_mixer_native_commands
for each row execute function public.agent_wake_on_native_command();

drop trigger if exists agent_wake_lighting_command on public.lighting_commands;
create trigger agent_wake_lighting_command
after insert on public.lighting_commands
for each row execute function public.agent_wake_on_lighting_command();

drop trigger if exists agent_wake_screen_command on public.gas_mixer_remote_commands;
create trigger agent_wake_screen_command
after insert on public.gas_mixer_remote_commands
for each row execute function public.agent_wake_on_screen_activity();

drop trigger if exists agent_wake_screen_session on public.gas_mixer_remote_sessions;
create trigger agent_wake_screen_session
after insert or update of status, expires_at on public.gas_mixer_remote_sessions
for each row execute function public.agent_wake_on_screen_activity();

-- Every screen-agent poll looks for an active session; serve it from an index.
create index if not exists gas_mixer_remote_sessions_active_idx
  on public.gas_mixer_remote_sessions (project_id, device_id, expires_at)
  where status in ('issued', 'connected');

-- Status reads are unchanged except for a throttled viewer-attention write.
-- VOLATILE lets PostgREST run them read-write; the write is skipped (never
-- awaited) while an agent holds the row, and any failure leaves the read intact.
create or replace function public.gas_mixer_native_status(requested_project_id uuid, requested_device_id text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  expected_project_id constant uuid :=
    '44444444-4444-4444-8444-444444444441'::uuid;
  expected_device_id constant text := 'gas-mixer:b827eb548a44';
  native_state public.gas_mixer_native_device_state%rowtype;
  latest_command public.gas_mixer_native_commands%rowtype;
begin
  if requested_project_id <> expected_project_id
     or requested_device_id <> expected_device_id
     or not public.has_gas_mixer_native_access(
       requested_project_id,
       requested_device_id,
       'remote_view'
     ) then
    raise exception 'Gas mixer access is required'
      using errcode = '42501';
  end if;

  select *
  into native_state
  from public.gas_mixer_native_device_state
  where project_id = requested_project_id
    and device_id = requested_device_id;

  if native_state.project_id is not null
     and (native_state.agent_attention_until is null
          or native_state.agent_attention_until < now() + interval '25 seconds') then
    begin
      update public.gas_mixer_native_device_state state
      set agent_attention_until = now() + interval '40 seconds'
      from (
        select project_id, device_id
        from public.gas_mixer_native_device_state
        where project_id = requested_project_id
          and device_id = requested_device_id
        for update skip locked
      ) unlocked
      where state.project_id = unlocked.project_id
        and state.device_id = unlocked.device_id;
      if found and (native_state.agent_attention_until is null
                    or native_state.agent_attention_until <= now()) then
        perform pg_notify('exacth2o_agent_wake', 'native:' || requested_device_id);
      end if;
    exception when others then
      null;
    end;
  end if;

  select *
  into latest_command
  from public.gas_mixer_native_commands
  where project_id = requested_project_id
    and device_id = requested_device_id
    and requested_by = auth.uid()
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'project_id', requested_project_id,
    'device_id', requested_device_id,
    'bridge_ready', coalesce(
      native_state.bridge_connected
      and native_state.bridge_ready
      and native_state.last_bridge_at >= now() - interval '45 seconds',
      false
    ),
    'bridge_version', native_state.bridge_version,
    'last_bridge_at', native_state.last_bridge_at,
    'state_revision', coalesce(native_state.state_revision, 0),
    'requested_state', native_state.requested_state,
    'applied_state', native_state.applied_state,
    'observed_state', native_state.observed_state,
    'remote_control_allowed', public.has_gas_mixer_native_access(
      requested_project_id,
      requested_device_id,
      'remote_control'
    ),
    'last_command', case
      when latest_command.id is null then null
      else jsonb_build_object(
        'id', latest_command.id,
        'field', latest_command.payload ->> 'field',
        'status', latest_command.status,
        'created_at', latest_command.created_at,
        'completed_at', latest_command.completed_at,
        'error_message', latest_command.error_message
      )
    end
  );
end;
$function$;

create or replace function public.lighting_native_status(requested_project_id uuid, requested_device_id text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  expected_project_id constant uuid :=
    '44444444-4444-4444-8444-444444444441'::uuid;
  expected_device_id constant text := 'lighting:beagle';
  lighting_state public.lighting_device_state%rowtype;
  latest_command public.lighting_commands%rowtype;
begin
  if requested_project_id <> expected_project_id
     or requested_device_id <> expected_device_id
     or not public.has_gas_mixer_module_access(
       requested_project_id,
       requested_device_id,
       'remote_view'
     ) then
    raise exception 'Gas mixer installation access is required'
      using errcode = '42501';
  end if;

  select *
  into lighting_state
  from public.lighting_device_state
  where project_id = requested_project_id
    and device_id = requested_device_id;

  if lighting_state.project_id is not null
     and (lighting_state.agent_attention_until is null
          or lighting_state.agent_attention_until < now() + interval '25 seconds') then
    begin
      update public.lighting_device_state state
      set agent_attention_until = now() + interval '40 seconds'
      from (
        select project_id, device_id
        from public.lighting_device_state
        where project_id = requested_project_id
          and device_id = requested_device_id
        for update skip locked
      ) unlocked
      where state.project_id = unlocked.project_id
        and state.device_id = unlocked.device_id;
      if found and (lighting_state.agent_attention_until is null
                    or lighting_state.agent_attention_until <= now()) then
        perform pg_notify('exacth2o_agent_wake', 'lighting:' || requested_device_id);
      end if;
    exception when others then
      null;
    end;
  end if;

  select *
  into latest_command
  from public.lighting_commands
  where project_id = requested_project_id
    and device_id = requested_device_id
    and requested_by = auth.uid()
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'project_id', requested_project_id,
    'device_id', requested_device_id,
    'bridge_ready', coalesce(
      lighting_state.bridge_connected
      and lighting_state.bridge_ready
      and lighting_state.last_bridge_at >= now() - interval '15 seconds',
      false
    ),
    'bridge_version', lighting_state.bridge_version,
    'last_bridge_at', lighting_state.last_bridge_at,
    'state_revision', coalesce(lighting_state.state_revision, 0),
    'requested_intensity', lighting_state.requested_intensity,
    'controller_intensity', lighting_state.controller_intensity,
    'last_nonzero_intensity', lighting_state.last_nonzero_intensity,
    'last_source', lighting_state.last_source,
    'hardware_verification', lighting_state.hardware_verification,
    'controller_process_started_at', lighting_state.controller_process_started_at,
    'remote_control_allowed', public.has_gas_mixer_module_access(
      requested_project_id,
      requested_device_id,
      'remote_control'
    ),
    'last_command', case
      when latest_command.id is null then null
      else jsonb_build_object(
        'id', latest_command.id,
        'intensity', latest_command.intensity,
        'status', latest_command.status,
        'created_at', latest_command.created_at,
        'completed_at', latest_command.completed_at,
        'controller_intensity', latest_command.controller_intensity,
        'error_message', latest_command.error_message
      )
    end
  );
end;
$function$;

notify pgrst, 'reload schema';

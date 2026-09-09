-- The Gas Mixer tile includes native controls, the original remote screen, and lights.
-- Keep this installation-specific grant separate from irrigation and global admin access.
create or replace function public.has_gas_mixer_module_access(
  check_project_id uuid, check_device_id text, check_capability text default 'remote_view'
) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    check_project_id = '44444444-4444-4444-8444-444444444441'::uuid
    and check_device_id in ('gas-mixer:b827eb548a44', 'lighting:beagle')
    and check_capability in ('remote_view', 'remote_control')
    and (public.has_system_admin_installation_access(check_project_id, check_device_id, check_capability)
      or exists (
        select 1 from public.gas_mixer_researcher_access a
        where a.user_id = auth.uid() and a.enabled and a.revoked_at is null
          and (check_capability = 'remote_view' or a.can_control)
          and exists (select 1 from public.portal_access p where p.user_id = a.user_id and p.role in ('researcher', 'admin'))
      )), false);
$$;
revoke all on function public.has_gas_mixer_module_access(uuid,text,text) from public, anon;
grant execute on function public.has_gas_mixer_module_access(uuid,text,text) to authenticated, service_role;
comment on table public.gas_mixer_researcher_access is
  'Scoped access to the complete Gas Mixer tile: native mixer, remote screen, and lighting. No irrigation or global admin access.';

create or replace function public.gas_mixer_remote_status(
  requested_project_id uuid,
  requested_device_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  expected_project_id constant uuid :=
    '44444444-4444-4444-8444-444444444441'::uuid;
  expected_device_id constant text :=
    'gas-mixer:b827eb548a44';
  device_status public.gas_mixer_device_status%rowtype;
  active_session public.gas_mixer_remote_sessions%rowtype;
  controller_email text;
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
  into device_status
  from public.gas_mixer_device_status
  where project_id = requested_project_id
    and device_id = requested_device_id;

  select *
  into active_session
  from public.gas_mixer_remote_sessions
  where project_id = requested_project_id
    and device_id = requested_device_id
    and status in ('issued', 'connected')
    and expires_at > now()
  order by issued_at desc
  limit 1;

  if active_session.user_id is not null then
    select email
    into controller_email
    from public.portal_access
    where user_id = active_session.user_id
      and role in ('admin', 'researcher')
    order by created_at
    limit 1;
  end if;

  return jsonb_build_object(
    'project_id', requested_project_id,
    'device_id', requested_device_id,
    'device_name', 'Gas Mixer Raspberry Pi',
    'online', coalesce(
      device_status.connected
      and device_status.local_session_available
      and device_status.last_heartbeat_at >= now() - interval '45 seconds',
      false
    ),
    'last_seen_at', device_status.last_heartbeat_at,
    'remote_control_allowed', public.has_gas_mixer_module_access(
      requested_project_id,
      requested_device_id,
      'remote_control'
    ),
    'active_session', active_session.id is not null,
    'active_controller_email', controller_email
  );
end;
$$;

create or replace function public.lighting_native_status(
  requested_project_id uuid,
  requested_device_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
$$;

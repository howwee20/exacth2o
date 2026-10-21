-- Rollback for 20261021160000_full_scale_autocalibration_and_manual_hold.sql.
-- Run only after confirming no queued or running remap_pairing_valves /
-- restore_pairing_settings command exists. Session records are dropped; download any
-- you need first (select record, original_snapshot from public.commissioning_sessions).
begin;

drop function if exists public.confirm_autocalibration_delivery(uuid, text, text, text[], text);
drop function if exists public.reconcile_autocalibration_bindings(uuid, text, text, jsonb);
drop function if exists public.record_valve_output_label(uuid, text, uuid, integer, integer, integer, text);
drop table if exists public.valve_output_labels;
drop table if exists public.manual_hold_sessions;
drop function if exists public.renew_commissioning_run(uuid, text, text, uuid);
drop function if exists public.claim_commissioning_run(uuid, text, text, uuid, integer);
drop trigger if exists protect_commissioning_session on public.commissioning_sessions;
drop function if exists public.protect_commissioning_session();
drop table if exists public.commissioning_sessions;

alter table public.hardware_bindings drop constraint if exists hardware_bindings_source_check;
alter table public.hardware_bindings add constraint hardware_bindings_source_check
  check (source in ('pairing_snapshot', 'researcher_confirmed', 'physical_verification', 'simulator'));

create or replace function public.assert_portal_command_access(project uuid, actor uuid, action text)
returns void language plpgsql security definer set search_path=public as $$
declare actor_portal_role text;
begin
  if not coalesce((select enabled from public.control_command_intake_settings where singleton),false) then
    raise exception 'Controller command intake is paused' using errcode='42501';
  end if;
  select role into actor_portal_role from public.portal_access
    where project_id=project and user_id=actor and access_scope='project';
  if actor_portal_role is null or actor_portal_role not in ('admin','researcher') then
    raise exception 'Current project control access is required' using errcode='42501';
  end if;
  if action in ('update_pairing','bulk_update_pairings','create_pairing','create_group','remove_group','manual_water','update_system_state','export_data') then return; end if;
  if actor_portal_role='admin' and action in ('delete_pairing','create_calibration','delete_calibration','apply_calibration','update_board_config') then return; end if;
  raise exception 'This controller command is not permitted for the current role' using errcode='42501';
end; $$;
revoke all on function public.assert_portal_command_access(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.assert_portal_command_access(uuid,uuid,text) to service_role;

-- The previous settings-batch function (from 20260724144500_add_guarded_pairing_delete),
-- so no batch can carry remap_pairing_valves or restore_pairing_settings again.
-- The command_type constraint keeps the two types: completed commands of those types
-- stay valid history rows, and assert_portal_command_access above refuses new ones.
create or replace function public.enqueue_portal_control_command_batch(
  command_project_id uuid,
  command_device_id text,
  command_requested_by uuid,
  command_batch_id uuid,
  command_expires_at timestamptz,
  expected_config_hash text,
  expected_controller_state text,
  batch_commands jsonb
)
returns setof public.project_control_commands
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  command_item jsonb;
  command_index integer := 0;
  command_count integer;
  command_type_value text;
  command_payload_value jsonb;
  command_client_id uuid;
  previous_command_id uuid;
  queued_command public.project_control_commands%rowtype;
  current_config_hash text;
  current_controller_state text;
  current_state_fresh_until timestamptz;
  normalized_expected_controller_state text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may enqueue portal control command batches';
  end if;
  if command_batch_id is null then
    raise exception 'A command batch ID is required';
  end if;
  if jsonb_typeof(batch_commands) <> 'array' then
    raise exception 'Batch commands must be an array';
  end if;

  command_count := jsonb_array_length(batch_commands);
  if command_count < 3 or command_count > 22 then
    raise exception 'A settings batch must contain 3-22 commands';
  end if;
  normalized_expected_controller_state := lower(trim(coalesce(expected_controller_state, '')));
  if normalized_expected_controller_state not in ('running', 'stopped') then
    raise exception 'The reviewed controller state is invalid';
  end if;
  if batch_commands->0->>'command_type' <> 'update_system_state'
    or batch_commands->0->'payload'->>'state' <> 'stopped'
    or batch_commands->(command_count - 1)->>'command_type' <> 'update_system_state'
    or batch_commands->(command_count - 1)->'payload'->>'state' <> normalized_expected_controller_state then
    raise exception 'A settings batch must stop first and restore the reviewed state last';
  end if;

  select config.config_hash
  into current_config_hash
  from public.device_config_state config
  where config.project_id = command_project_id
    and config.device_id = trim(command_device_id)
  order by config.updated_at desc
  limit 1;
  if current_config_hash is null
    or current_config_hash is distinct from expected_config_hash then
    raise exception 'Controller configuration changed before the settings batch was queued';
  end if;

  select lower(trim(runtime.controller_state)), runtime.state_fresh_until
  into current_controller_state, current_state_fresh_until
  from public.device_runtime_state runtime
  where runtime.project_id = command_project_id
    and runtime.device_id = trim(command_device_id)
  order by runtime.updated_at desc
  limit 1;
  if current_controller_state is null
    or current_controller_state is distinct from normalized_expected_controller_state
    or current_state_fresh_until is null
    or current_state_fresh_until <= now() then
    raise exception 'Controller state changed or is stale; refresh before applying settings';
  end if;

  for command_item in select value from jsonb_array_elements(batch_commands)
  loop
    command_index := command_index + 1;
    command_type_value := command_item->>'command_type';
    command_payload_value := command_item->'payload';
    command_client_id := (command_item->>'client_request_id')::uuid;

    if command_client_id is null or jsonb_typeof(command_payload_value) <> 'object' then
      raise exception 'A settings batch command is invalid';
    end if;
    if command_index > 1 and command_index < command_count
      and command_type_value not in (
        'update_pairing',
        'bulk_update_pairings',
        'create_pairing',
        'delete_pairing',
        'create_group',
        'remove_group',
        'create_calibration',
        'delete_calibration',
        'apply_calibration',
        'update_board_config'
      ) then
      raise exception 'A settings batch contains an unsupported configuration command';
    end if;

    select *
    into queued_command
    from public.enqueue_portal_control_command(
      command_project_id,
      command_device_id,
      command_type_value,
      command_payload_value,
      command_requested_by,
      command_expires_at,
      coalesce((command_item->>'requires_confirmation')::boolean, false),
      case
        when coalesce((command_item->>'requires_confirmation')::boolean, false)
          then now()
        else null
      end,
      command_client_id
    )
    limit 1;

    if queued_command.batch_id is not null
      and (
        queued_command.batch_id is distinct from command_batch_id
        or queued_command.experiment_id is not null
        or queued_command.depends_on_command_id is distinct from previous_command_id
      ) then
      raise exception 'Existing command metadata does not match the settings batch';
    end if;

    update public.project_control_commands
    set batch_id = command_batch_id,
        experiment_id = null,
        depends_on_command_id = previous_command_id
    where id = queued_command.id
    returning * into queued_command;

    previous_command_id := queued_command.id;
    return next queued_command;
  end loop;
end;
$$;

revoke all on function public.enqueue_portal_control_command_batch(
  uuid, text, uuid, uuid, timestamptz, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.enqueue_portal_control_command_batch(
  uuid, text, uuid, uuid, timestamptz, text, text, jsonb
) to service_role;

comment on function public.enqueue_portal_control_command_batch(
  uuid, text, uuid, uuid, timestamptz, text, text, jsonb
) is
  'Atomically enqueues a reviewed STOP-config-restore settings chain against exact mirrored config and runtime state.';

commit;

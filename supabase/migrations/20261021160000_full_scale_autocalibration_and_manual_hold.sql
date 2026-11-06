-- Full-scale (100-pot) autocalibration and hold-to-water troubleshooting.
--
-- Adds two atomic controller commands that let one reviewed settings batch apply a
-- valve permutation of any size (remap_pairing_valves) and restore every pot's own
-- recorded settings (restore_pairing_settings); a durable record of each
-- autocalibration session (original settings, evidence, state), with at most one
-- active session per controller; a record of manual hold sessions, which
-- autocalibration reads to detect manual watering during a run; and binding
-- reconciliation after a verified remap that keeps pot identity and resets physical
-- verification to software-only.
--
-- Nothing here enqueues a command, changes a pairing, target, schedule, calibration
-- or watering state, or touches a controller. Rollback:
-- supabase/rollbacks/20261021_full_scale_autocalibration_and_manual_hold.sql

-- ---------------------------------------------------------------- command types

alter table public.project_control_commands
  drop constraint if exists project_control_commands_command_type_check;

alter table public.project_control_commands
  add constraint project_control_commands_command_type_check
  check (
    command_type in (
      'update_pairing',
      'bulk_update_pairings',
      'create_pairing',
      'delete_pairing',
      'create_group',
      'remove_group',
      'create_calibration',
      'delete_calibration',
      'apply_calibration',
      'remap_pairing_valves',
      'restore_pairing_settings',
      'manual_water',
      'update_board_config',
      'initialize_sensors',
      'update_system_state',
      'export_data'
    )
  );

-- Researchers already manage pairings and watering; a reviewed valve remap or settings
-- restore keeps every pot's identity, group and calibration, so it follows the same
-- role rule as update_pairing. Pairing deletion and calibration changes stay admin-only.
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
  if action in ('update_pairing','bulk_update_pairings','create_pairing','create_group','remove_group','remap_pairing_valves','restore_pairing_settings','manual_water','update_system_state','export_data') then return; end if;
  if actor_portal_role='admin' and action in ('delete_pairing','create_calibration','delete_calibration','apply_calibration','update_board_config') then return; end if;
  raise exception 'This controller command is not permitted for the current role' using errcode='42501';
end; $$;
revoke all on function public.assert_portal_command_access(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.assert_portal_command_access(uuid,uuid,text) to service_role;

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
        'remap_pairing_valves',
        'restore_pairing_settings',
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

-- ---------------------------------------------------------------- autocalibration sessions

create table if not exists public.commissioning_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 200),
  run_id text not null check (char_length(run_id) between 8 and 120),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  operator_label text check (operator_label is null or char_length(operator_label) <= 200),
  status text not null default 'preparing' check (status in (
    'preparing', 'prepared', 'running', 'interrupted', 'analyzed', 'applying', 'applied',
    'verified', 'restoring', 'restored', 'rolled_back', 'abandoned', 'failed'
  )),
  active boolean not null default true,
  pot_count integer not null check (pot_count between 1 and 200),
  -- Every selected pot's settings before anything was changed: exact controller values.
  original_snapshot jsonb not null check (jsonb_typeof(original_snapshot) = 'array'),
  -- Selection, approvals, queued batches, events: small, saved often.
  record jsonb not null default '{}'::jsonb check (jsonb_typeof(record) = 'object'),
  -- The run's evidence matrix (every pulse measured on every selected sensor): large,
  -- saved at checkpoints and when a run segment ends, read only when needed.
  run_result jsonb check (run_result is null or jsonb_typeof(run_result) = 'object'),
  config_hash_at_start text,
  -- A run is driven by one browser screen. While it runs, that screen renews this
  -- heartbeat; another screen that sees it go stale knows no further pulse is coming.
  heartbeat_at timestamptz,
  -- Identifies the screen driving the current run segment; renewals must present it.
  run_token uuid,
  -- Another operator's request that the running screen stop (it checks on each heartbeat).
  stop_requested_at timestamptz,
  stop_requested_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (project_id, run_id),
  check (octet_length(record::text) <= 2000000),
  check (run_result is null or octet_length(run_result::text) <= 12000000),
  check (octet_length(original_snapshot::text) <= 1000000)
);

-- At most one autocalibration session holds a controller at a time.
create unique index if not exists commissioning_sessions_one_active
  on public.commissioning_sessions (project_id, device_id)
  where active;
create index if not exists commissioning_sessions_recent
  on public.commissioning_sessions (project_id, device_id, started_at desc);

alter table public.commissioning_sessions enable row level security;
revoke all on public.commissioning_sessions from public, anon, authenticated;
grant select, insert, update on public.commissioning_sessions to authenticated;
grant all on public.commissioning_sessions to service_role;

drop policy if exists "project members read commissioning sessions" on public.commissioning_sessions;
create policy "project members read commissioning sessions"
  on public.commissioning_sessions for select to authenticated
  using (public.has_portal_access(project_id));

drop policy if exists "operators start commissioning sessions" on public.commissioning_sessions;
create policy "operators start commissioning sessions"
  on public.commissioning_sessions for insert to authenticated
  with check (
    public.has_portal_project_role(project_id, array['admin', 'researcher'])
    and created_by = (select auth.uid())
  );

drop policy if exists "operators update commissioning sessions" on public.commissioning_sessions;
create policy "operators update commissioning sessions"
  on public.commissioning_sessions for update to authenticated
  using (public.has_portal_project_role(project_id, array['admin', 'researcher']))
  with check (public.has_portal_project_role(project_id, array['admin', 'researcher']));

-- The original settings are written once; later updates may not rewrite them, so a
-- restore always returns pots to what they were before the session began.
create or replace function public.protect_commissioning_session()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.original_snapshot is distinct from old.original_snapshot then
    raise exception 'The recorded original settings of a commissioning session cannot be changed';
  end if;
  if new.project_id is distinct from old.project_id or new.device_id is distinct from old.device_id
    or new.run_id is distinct from old.run_id or new.created_by is distinct from old.created_by then
    raise exception 'A commissioning session cannot move to another run, project, controller or owner';
  end if;
  if not old.active and new.active then
    raise exception 'A finished commissioning session cannot become active again';
  end if;
  -- Times come from the database clock, never from a browser.
  if new.heartbeat_at is distinct from old.heartbeat_at and new.heartbeat_at is not null then
    new.heartbeat_at := now();
  end if;
  if new.stop_requested_at is distinct from old.stop_requested_at then
    if new.stop_requested_at is null then
      new.stop_requested_by := null;
    else
      new.stop_requested_at := now();
      new.stop_requested_by := (select auth.uid());
    end if;
  end if;
  new.updated_at := now();
  if not new.active and new.ended_at is null then new.ended_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists protect_commissioning_session on public.commissioning_sessions;
create trigger protect_commissioning_session
before update on public.commissioning_sessions
for each row execute function public.protect_commissioning_session();

comment on table public.commissioning_sessions is
  'Autocalibration sessions: original settings (immutable), evidence and state. One active session per controller.';

-- A run segment is driven by exactly one screen. Claiming takes the session for a new
-- token unless another screen's heartbeat is still fresh (database clock); renewing
-- succeeds only for the current token, so a screen that slept through another screen's
-- resume learns it has lost the run before it can request another pulse.
create or replace function public.claim_commissioning_run(
  claim_project_id uuid,
  claim_device_id text,
  claim_run_id text,
  claim_token uuid,
  stale_after_seconds integer default 180
)
returns public.commissioning_sessions
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  session_row public.commissioning_sessions%rowtype;
begin
  if claim_token is null then
    raise exception 'A run token is required';
  end if;
  select * into session_row from public.commissioning_sessions
  where project_id = claim_project_id and device_id = claim_device_id and run_id = claim_run_id
  for update;
  if not found then
    raise exception 'Autocalibration session not found' using errcode = 'P0002';
  end if;
  if not session_row.active then
    raise exception 'This autocalibration session has ended';
  end if;
  if session_row.status = 'running'
    and session_row.run_token is distinct from claim_token
    and session_row.heartbeat_at is not null
    and session_row.heartbeat_at > now() - make_interval(secs => greatest(60, least(coalesce(stale_after_seconds, 180), 3600))) then
    raise exception 'Another screen is running this autocalibration session' using errcode = '55P03';
  end if;
  update public.commissioning_sessions
  set status = 'running', run_token = claim_token, heartbeat_at = now(), stop_requested_at = null
  where id = session_row.id
  returning * into session_row;
  return session_row;
end;
$$;

create or replace function public.renew_commissioning_run(
  renew_project_id uuid,
  renew_device_id text,
  renew_run_id text,
  renew_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  session_row public.commissioning_sessions%rowtype;
begin
  update public.commissioning_sessions
  set heartbeat_at = now()
  where project_id = renew_project_id and device_id = renew_device_id and run_id = renew_run_id
    and run_token = renew_token and active and status = 'running'
  returning * into session_row;
  if not found then
    raise exception 'This screen no longer holds the autocalibration run' using errcode = '55P03';
  end if;
  return jsonb_build_object(
    'stop_requested_at', session_row.stop_requested_at,
    'stop_requested_by', session_row.stop_requested_by,
    'heartbeat_at', session_row.heartbeat_at
  );
end;
$$;

revoke all on function public.claim_commissioning_run(uuid, text, text, uuid, integer) from public, anon;
revoke all on function public.renew_commissioning_run(uuid, text, text, uuid) from public, anon;
grant execute on function public.claim_commissioning_run(uuid, text, text, uuid, integer) to authenticated, service_role;
grant execute on function public.renew_commissioning_run(uuid, text, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- manual hold sessions

create table if not exists public.manual_hold_sessions (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 200),
  owner_id uuid not null references auth.users(id) on delete restrict,
  destination_kind text not null check (destination_kind in ('pot', 'solenoid')),
  pot_number integer check (pot_number is null or pot_number between 1 and 100),
  solenoid_number integer check (solenoid_number is null or solenoid_number between 1 and 1000),
  relay_address integer not null check (relay_address between 3 and 127),
  channel integer not null check (channel between 1 and 48),
  route_status text,
  pairing_name text,
  status text not null default 'opening' check (status in ('opening', 'open', 'closed', 'refused', 'unconfirmed', 'fault')),
  end_reason text,
  takeover_of uuid,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists manual_hold_sessions_recent
  on public.manual_hold_sessions (project_id, device_id, started_at desc);

alter table public.manual_hold_sessions enable row level security;
revoke all on public.manual_hold_sessions from public, anon, authenticated;
grant select on public.manual_hold_sessions to authenticated;
grant all on public.manual_hold_sessions to service_role;

drop policy if exists "project members read manual hold sessions" on public.manual_hold_sessions;
create policy "project members read manual hold sessions"
  on public.manual_hold_sessions for select to authenticated
  using (public.has_portal_access(project_id));

comment on table public.manual_hold_sessions is
  'Hold-to-water sessions recorded by the manual-hold Edge Function. Autocalibration reads them to detect manual watering during a run.';

-- ---------------------------------------------------------------- binding reconciliation

alter table public.hardware_bindings
  drop constraint if exists hardware_bindings_source_check;
alter table public.hardware_bindings
  add constraint hardware_bindings_source_check
  check (source in ('pairing_snapshot', 'researcher_confirmed', 'physical_verification', 'simulator', 'autocalibration'));

-- After the controller's own readback shows a pot's sensor on its new valve, retire the
-- old binding and record the new one for the same research pot. The new binding is
-- software-only: a measured response and a configuration readback are not proof that
-- water reaches the plant, and a confirmation made for the old valve no longer applies.
create or replace function public.reconcile_autocalibration_bindings(
  reconcile_project_id uuid,
  reconcile_device_id text,
  reconcile_run_id text,
  changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := (select auth.uid());
  config public.device_config_state%rowtype;
  change jsonb;
  current_binding public.hardware_bindings%rowtype;
  live jsonb;
  reconciled integer := 0;
  skipped jsonb := '[]'::jsonb;
  pairing_name_value text;
  sensor_value text;
  valve_value text;
begin
  if actor is null or not exists (
    select 1 from public.portal_access access
    where access.project_id = reconcile_project_id and access.user_id = actor
      and access.access_scope = 'project' and access.role in ('admin', 'researcher')
  ) then
    raise exception 'Current project control access is required' using errcode = '42501';
  end if;
  if jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes) > 200 then
    raise exception 'Changes must be a list of at most 200 pots';
  end if;
  select * into config from public.device_config_state
  where project_id = reconcile_project_id and device_id = reconcile_device_id;
  if not found then
    raise exception 'Controller configuration is unavailable';
  end if;

  for change in select value from jsonb_array_elements(changes)
  loop
    pairing_name_value := change->>'pairing_name';
    sensor_value := change->>'sensor_key';
    valve_value := change->>'valve_key';
    -- The controller's readback must already show this sensor on the new valve.
    select item into live
    from jsonb_array_elements(coalesce(config.pairings, '[]'::jsonb)) item
    where item->>'name' = pairing_name_value
      and (item->'Sensor'->>'boardSerialId') || ':' || (item->'Sensor'->>'address') = sensor_value
      and (item->'Valve'->>'relayAddress') || ':' || (item->'Valve'->>'address') = valve_value
    limit 1;
    if live is null then
      skipped := skipped || jsonb_build_object('pairing_name', pairing_name_value, 'reason', 'controller readback does not show this valve yet');
      continue;
    end if;

    select * into current_binding from public.hardware_bindings
    where project_id = reconcile_project_id and device_id = reconcile_device_id
      and pairing_name = pairing_name_value and retired_at is null
    limit 1;
    if not found then
      skipped := skipped || jsonb_build_object('pairing_name', pairing_name_value, 'reason', 'no active binding for this pot');
      continue;
    end if;
    if current_binding.valve_key = valve_value and current_binding.sensor_key = sensor_value then
      continue;
    end if;
    if current_binding.sensor_key <> sensor_value then
      skipped := skipped || jsonb_build_object('pairing_name', pairing_name_value, 'reason', 'the bound sensor differs; record a new binding at the bench');
      continue;
    end if;

    update public.hardware_bindings
    set retired_at = greatest(now(), effective_at),
        metadata = metadata || jsonb_build_object('retired_by', 'autocalibration', 'run_id', reconcile_run_id)
    where id = current_binding.id;

    insert into public.hardware_bindings (
      project_id, device_id, pot_id, pairing_id, pairing_name, sensor_key, valve_key,
      physical_status, source, effective_at, metadata
    ) values (
      reconcile_project_id, reconcile_device_id, current_binding.pot_id, current_binding.pairing_id,
      pairing_name_value, sensor_value, valve_value, 'software_only', 'autocalibration', now(),
      jsonb_build_object(
        'run_id', reconcile_run_id,
        'previous_valve_key', current_binding.valve_key,
        'previous_physical_status', current_binding.physical_status,
        'readback_config_hash', config.config_hash,
        'evidence', change->'evidence',
        'warning', 'Valve discovered from a measured sensor response and verified by controller readback; physical delivery is not yet confirmed.'
      )
    );
    reconciled := reconciled + 1;
  end loop;

  insert into public.project_control_audit (project_id, device_id, action, actor_id, status, details)
  values (reconcile_project_id, reconcile_device_id, 'autocalibration_bindings', actor, 'reconciled',
          jsonb_build_object('run_id', reconcile_run_id, 'reconciled', reconciled, 'skipped', skipped));

  return jsonb_build_object('reconciled', reconciled, 'skipped', skipped, 'config_hash', config.config_hash);
end;
$$;

revoke all on function public.reconcile_autocalibration_bindings(uuid, text, text, jsonb) from public, anon;
grant execute on function public.reconcile_autocalibration_bindings(uuid, text, text, jsonb) to authenticated, service_role;

-- The last of the four separate facts: an operator watched water from the pot's valve
-- reach the pot at the bench. Only a software-only binding whose sensor and valve the
-- controller still reports is confirmed; the binding is versioned (old one retired,
-- new one recorded), never edited in place.
create or replace function public.confirm_autocalibration_delivery(
  confirm_project_id uuid,
  confirm_device_id text,
  confirm_run_id text,
  pairing_names text[],
  note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := (select auth.uid());
  config public.device_config_state%rowtype;
  name_value text;
  current_binding public.hardware_bindings%rowtype;
  live jsonb;
  confirmed integer := 0;
  skipped jsonb := '[]'::jsonb;
begin
  if actor is null or not exists (
    select 1 from public.portal_access access
    where access.project_id = confirm_project_id and access.user_id = actor
      and access.access_scope = 'project' and access.role in ('admin', 'researcher')
  ) then
    raise exception 'Current project control access is required' using errcode = '42501';
  end if;
  if pairing_names is null or coalesce(array_length(pairing_names, 1), 0) not between 1 and 200 then
    raise exception 'Confirm between 1 and 200 pots at a time';
  end if;
  select * into config from public.device_config_state
  where project_id = confirm_project_id and device_id = confirm_device_id;
  if not found then
    raise exception 'Controller configuration is unavailable';
  end if;

  foreach name_value in array pairing_names
  loop
    select * into current_binding from public.hardware_bindings
    where project_id = confirm_project_id and device_id = confirm_device_id
      and pairing_name = name_value and retired_at is null
    limit 1;
    if not found then
      skipped := skipped || jsonb_build_object('pairing_name', name_value, 'reason', 'no active binding for this pot');
      continue;
    end if;
    if current_binding.physical_status <> 'software_only' then
      skipped := skipped || jsonb_build_object('pairing_name', name_value, 'reason', 'already ' || current_binding.physical_status);
      continue;
    end if;
    live := null;
    select item into live
    from jsonb_array_elements(coalesce(config.pairings, '[]'::jsonb)) item
    where item->>'name' = name_value
      and (item->'Sensor'->>'boardSerialId') || ':' || (item->'Sensor'->>'address') = current_binding.sensor_key
      and (item->'Valve'->>'relayAddress') || ':' || (item->'Valve'->>'address') = current_binding.valve_key
    limit 1;
    if live is null then
      skipped := skipped || jsonb_build_object('pairing_name', name_value, 'reason', 'the controller reports different wiring for this pot');
      continue;
    end if;

    update public.hardware_bindings
    set retired_at = greatest(now(), effective_at),
        metadata = metadata || jsonb_build_object('retired_by', 'delivery_confirmation', 'run_id', confirm_run_id)
    where id = current_binding.id;
    insert into public.hardware_bindings (
      project_id, device_id, pot_id, pairing_id, pairing_name, sensor_key, valve_key,
      physical_status, source, effective_at, metadata
    ) values (
      confirm_project_id, confirm_device_id, current_binding.pot_id, current_binding.pairing_id,
      name_value, current_binding.sensor_key, current_binding.valve_key, 'researcher_confirmed', 'researcher_confirmed', now(),
      jsonb_build_object(
        'run_id', confirm_run_id,
        'confirmed_by', actor,
        'previous_binding_id', current_binding.id,
        'readback_config_hash', config.config_hash,
        'note', left(coalesce(note, ''), 600),
        'meaning', 'An operator watched water from this valve reach this pot at the bench.'
      )
    );
    confirmed := confirmed + 1;
  end loop;

  insert into public.project_control_audit (project_id, device_id, action, actor_id, status, details)
  values (confirm_project_id, confirm_device_id, 'autocalibration_delivery_confirmed', actor, 'confirmed',
          jsonb_build_object('run_id', confirm_run_id, 'confirmed', confirmed, 'skipped', skipped));
  return jsonb_build_object('confirmed', confirmed, 'skipped', skipped);
end;
$$;

revoke all on function public.confirm_autocalibration_delivery(uuid, text, text, text[], text) from public, anon;
grant execute on function public.confirm_autocalibration_delivery(uuid, text, text, text[], text) to authenticated, service_role;

-- ---------------------------------------------------------------- solenoid labels

-- The logical solenoid number an operator reads on the output board (the printed SSR
-- label), recorded against the output's board address and channel. It is never
-- derived from a display index: an unlabelled output is still listed and usable by
-- its board and channel. A label says nothing about which pot the output waters;
-- that is manual_valve_routes.
create table if not exists public.valve_output_labels (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 200),
  solenoid_number integer not null check (solenoid_number between 1 and 1000),
  relay_address integer not null check (relay_address between 3 and 127),
  channel integer not null check (channel between 1 and 48),
  status text not null check (status in ('confirmed', 'needs_confirmation')),
  source text not null check (char_length(source) between 1 and 80),
  evidence text not null default '' check (char_length(evidence) <= 600),
  confirmed_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id, solenoid_number),
  unique (project_id, device_id, relay_address, channel)
);
alter table public.valve_output_labels enable row level security;
revoke all on table public.valve_output_labels from public, anon, authenticated;
grant select, insert, update, delete on table public.valve_output_labels to service_role;
comment on table public.valve_output_labels is
  'Printed solenoid (SSR) numbers for valve outputs, with evidence. Read and written by the manual-hold Edge Function only.';

create or replace function public.record_valve_output_label(
  label_project_id uuid, label_device_id text, actor uuid,
  label_solenoid_number integer, label_relay_address integer, label_channel integer, label_note text default ''
) returns public.valve_output_labels
language plpgsql security definer set search_path = public as $$
declare
  saved public.valve_output_labels%rowtype;
begin
  if not exists (select 1 from public.portal_access where project_id = label_project_id and user_id = actor
                 and access_scope = 'project' and role = 'admin') then
    raise exception 'Project admin access is required to record solenoid labels' using errcode = '42501';
  end if;
  delete from public.valve_output_labels
  where project_id = label_project_id and device_id = label_device_id
    and relay_address = label_relay_address and channel = label_channel and solenoid_number <> label_solenoid_number;
  insert into public.valve_output_labels(project_id, device_id, solenoid_number, relay_address, channel, status, source, evidence, confirmed_by, updated_at)
  values (label_project_id, label_device_id, label_solenoid_number, label_relay_address, label_channel, 'confirmed', 'admin',
          coalesce(left(label_note, 600), ''), actor, now())
  on conflict (project_id, device_id, solenoid_number) do update
    set relay_address = excluded.relay_address, channel = excluded.channel, status = 'confirmed', source = 'admin',
        evidence = excluded.evidence, confirmed_by = excluded.confirmed_by, updated_at = now()
  returning * into saved;
  insert into public.project_control_audit(project_id, device_id, action, actor_id, status, details)
  values (label_project_id, label_device_id, 'solenoid_label_confirm', actor, 'confirmed',
          jsonb_build_object('solenoid_number', label_solenoid_number, 'relay_address', label_relay_address, 'channel', label_channel, 'note', saved.evidence));
  return saved;
end; $$;
revoke all on function public.record_valve_output_label(uuid, text, uuid, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.record_valve_output_label(uuid, text, uuid, integer, integer, integer, text) to service_role;

-- The greenhouse controller's output boards follow one printed scheme (SSR 1-48 on
-- 0x24, 49-96 on 0x20, 97-144 on 0x26). Only SSR 74 has been read off the board in a
-- field record, so every other label starts as needing confirmation at the board.
do $$
declare
  project constant uuid := '22222222-2222-4222-8222-222222222222';
  device constant text := '3100e37ee3205651fe3dd86dafd4dc0c';
begin
  if not exists (select 1 from public.device_config_state where project_id = project and device_id = device) then return; end if;
  insert into public.valve_output_labels(project_id, device_id, solenoid_number, relay_address, channel, status, source, evidence)
  select project, device, number, relay, channel,
         case when number = 74 then 'confirmed' else 'needs_confirmation' end,
         case when number = 74 then 'field_test_2026-08-03' else 'pcb_label_scheme' end,
         case when number = 74 then 'August 3 field test: printed SSR 74 is output 0x20:26.'
              else 'From the output board''s printed numbering (1-48 on 0x24, 49-96 on 0x20, 97-144 on 0x26). Read the printed label to confirm.' end
  from (
    select n as number,
           case when n <= 48 then 36 when n <= 96 then 32 else 38 end as relay,
           ((n - 1) % 48) + 1 as channel
    from generate_series(1, 144) n
  ) scheme
  on conflict do nothing;
end $$;

-- Gas Mixer V2 native form contract.
--
-- This is additive to the existing image/tap bridge. It does not write an MFC,
-- open the Alicat serial port, or alter the running Raspberry Pi application.
-- Native commands fail closed until tomorrow's in-process Pi bridge reports a
-- fresh, commissioned heartbeat.

create table public.gas_mixer_native_device_state (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  bridge_connected boolean not null default false,
  bridge_ready boolean not null default false,
  bridge_version text,
  last_bridge_at timestamptz,
  state_revision bigint not null default 0 check (state_revision >= 0),
  requested_state jsonb not null check (jsonb_typeof(requested_state) = 'object'),
  applied_state jsonb not null check (jsonb_typeof(applied_state) = 'object'),
  observed_state jsonb not null check (jsonb_typeof(observed_state) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id),
  check (project_id = '44444444-4444-4444-8444-444444444441'::uuid),
  check (device_id = 'gas-mixer:b827eb548a44')
);

create table public.gas_mixer_native_commands (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  command_type text not null check (command_type in ('set_field')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  expected_revision bigint not null check (expected_revision >= 0),
  idempotency_key uuid not null unique,
  status text not null default 'queued'
    check (status in ('queued', 'accepted', 'applied', 'verified', 'rejected', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 seconds'),
  accepted_at timestamptz,
  applied_at timestamptz,
  completed_at timestamptz,
  error_message text,
  check (expires_at <= created_at + interval '15 seconds')
);

create index gas_mixer_native_commands_poll_idx
  on public.gas_mixer_native_commands (project_id, device_id, status, created_at)
  where status in ('queued', 'accepted', 'applied');

create index gas_mixer_native_commands_user_idx
  on public.gas_mixer_native_commands (requested_by, created_at desc);

alter table public.gas_mixer_native_device_state enable row level security;
alter table public.gas_mixer_native_commands enable row level security;

revoke all on public.gas_mixer_native_device_state from public, anon, authenticated;
revoke all on public.gas_mixer_native_commands from public, anon, authenticated;
grant select, insert, update on public.gas_mixer_native_device_state to service_role;
grant select, insert, update on public.gas_mixer_native_commands to service_role;

with initial_state as (
  select jsonb_build_object(
    'use_licor', false,
    'total_slpm', 0,
    'channels', jsonb_build_object(
      'A', jsonb_build_object('address', 'A', 'formula', 'N2', 'balance', true, 'ratio_unit', '%', 'flow_unit', 'SLPM', 'ratio', 100, 'setpoint', 0, 'delivered', 0, 'available', true, 'flow_error', false),
      'B', jsonb_build_object('address', 'B', 'formula', 'O2', 'balance', false, 'ratio_unit', '%', 'flow_unit', 'SLPM', 'ratio', 0, 'setpoint', 0, 'delivered', 0, 'available', true, 'flow_error', false),
      'C', jsonb_build_object('address', 'C', 'formula', 'Ar', 'balance', false, 'ratio_unit', 'PPM', 'flow_unit', 'SCCM', 'ratio', 0, 'setpoint', 0, 'delivered', 0, 'available', false, 'flow_error', false),
      'D', jsonb_build_object('address', 'D', 'formula', 'CO2', 'balance', false, 'ratio_unit', 'PPM', 'flow_unit', 'SCCM', 'ratio', 0, 'setpoint', 0, 'delivered', 0, 'available', true, 'flow_error', false),
      'E', jsonb_build_object('address', 'E', 'formula', 'N2', 'balance', false, 'ratio_unit', '%', 'flow_unit', 'SLPM', 'ratio', 0, 'setpoint', 0, 'delivered', 0, 'available', false, 'flow_error', false),
      'F', jsonb_build_object('address', 'F', 'formula', 'O2', 'balance', false, 'ratio_unit', '%', 'flow_unit', 'SLPM', 'ratio', 0, 'setpoint', 0, 'delivered', 0, 'available', false, 'flow_error', false)
    )
  ) as value
)
insert into public.gas_mixer_native_device_state (
  project_id,
  device_id,
  requested_state,
  applied_state,
  observed_state,
  metadata
)
select
  '44444444-4444-4444-8444-444444444441'::uuid,
  'gas-mixer:b827eb548a44',
  value,
  value,
  value,
  jsonb_build_object(
    'commissioning_state', 'bridge_pending',
    'source_contract', 'pi-mfc-gui-2019-backup',
    'existing_screen_bridge_preserved', true
  )
from initial_state
on conflict (project_id, device_id) do nothing;

update public.project_platform_config
set
  capability_contract_version = '2026-09-01.chamber-control-gas-mixer-v2',
  display_config = display_config || jsonb_build_object(
    'native_mixer_primary', true,
    'existing_screen_bridge_preserved', true
  ),
  control_policy = control_policy || jsonb_build_object(
    'native_command_mode', 'commissioning_required',
    'physical_pi_authoritative', true,
    'requested_applied_observed', true
  ),
  updated_at = now()
where project_id = '44444444-4444-4444-8444-444444444441'::uuid;

create or replace function public.gas_mixer_native_status(
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
  expected_device_id constant text := 'gas-mixer:b827eb548a44';
  native_state public.gas_mixer_native_device_state%rowtype;
  latest_command public.gas_mixer_native_commands%rowtype;
begin
  if requested_project_id <> expected_project_id
     or requested_device_id <> expected_device_id
     or not public.has_system_admin_installation_access(
       requested_project_id,
       requested_device_id,
       'remote_view'
     ) then
    raise exception 'System-admin installation access is required'
      using errcode = '42501';
  end if;

  select *
  into native_state
  from public.gas_mixer_native_device_state
  where project_id = requested_project_id
    and device_id = requested_device_id;

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
    'remote_control_allowed', public.has_system_admin_installation_access(
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
$$;

revoke all on function public.gas_mixer_native_status(uuid, text)
  from public, anon;
grant execute on function public.gas_mixer_native_status(uuid, text)
  to authenticated, service_role;

comment on table public.gas_mixer_native_device_state is
  'Structured requested, applied, and physically observed Gas Mixer V2 state. The Pi remains authoritative.';
comment on table public.gas_mixer_native_commands is
  'Short-lived, validated native form commands. Commands remain disabled until the Pi bridge is commissioned.';
comment on function public.gas_mixer_native_status(uuid, text) is
  'Fail-closed system-admin projection for the native Gas Mixer V2 form.';

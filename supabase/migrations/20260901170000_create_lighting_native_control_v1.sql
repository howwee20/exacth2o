-- Native lighting control for the legacy BEAGLE chamber controller.
--
-- The existing NetBeans application remains the only hardware owner. The
-- ExactH2O bridge joins that JVM and calls the same Control.setIntensity() /
-- Control.update() path used by the local maintenance window and experiment
-- timeline. The light hardware has no readable ACK/photometric feedback, so
-- the contract records controller-observed state without claiming physical
-- verification.

insert into public.devices (
  id,
  organization_id,
  project_id,
  balena_uuid,
  name,
  status,
  last_seen_at
)
select
  'lighting:beagle',
  project.organization_id,
  project.id,
  null,
  'BEAGLE Lighting Controller',
  'provisioning',
  null
from public.projects project
where project.id = '44444444-4444-4444-8444-444444444441'::uuid
on conflict (id) do update
set name = excluded.name;

insert into public.system_admin_installation_access (
  project_id,
  device_id,
  portal_project_id,
  user_id,
  capability,
  enabled,
  revoked_at,
  granted_at,
  granted_by,
  metadata
)
select
  access.project_id,
  'lighting:beagle',
  access.portal_project_id,
  access.user_id,
  access.capability,
  access.enabled,
  access.revoked_at,
  access.granted_at,
  access.granted_by,
  access.metadata || jsonb_build_object('copied_from_device', access.device_id)
from public.system_admin_installation_access access
where access.project_id = '44444444-4444-4444-8444-444444444441'::uuid
  and access.device_id = 'gas-mixer:b827eb548a44'
  and access.capability in ('observe', 'export', 'remote_view', 'remote_control')
on conflict (project_id, device_id, user_id, capability) do update
set
  enabled = excluded.enabled,
  revoked_at = excluded.revoked_at,
  metadata = excluded.metadata;

create table public.lighting_agent_credentials (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  rotated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  primary key (project_id, device_id)
);

insert into public.lighting_agent_credentials (
  project_id,
  device_id,
  token_hash,
  metadata
) values (
  '44444444-4444-4444-8444-444444444441'::uuid,
  'lighting:beagle',
  '2757e34f485b4143bf4b0a98184409e37036546db7b9d498e8650bda5ca50f24',
  jsonb_build_object('credential_version', 1, 'created_for', 'beagle_jvm_lighting_bridge')
)
on conflict (project_id, device_id) do update
set
  token_hash = excluded.token_hash,
  enabled = true,
  rotated_at = now(),
  metadata = excluded.metadata;

create table public.lighting_device_state (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  bridge_connected boolean not null default false,
  bridge_ready boolean not null default false,
  bridge_version text,
  last_bridge_at timestamptz,
  state_revision bigint not null default 0 check (state_revision >= 0),
  requested_intensity numeric(8,3) not null default 0
    check (requested_intensity = 0 or requested_intensity between 10 and 2090),
  controller_intensity numeric(8,3) not null default 0
    check (controller_intensity = 0 or controller_intensity between 10 and 2090),
  last_nonzero_intensity numeric(8,3) not null default 10
    check (last_nonzero_intensity between 10 and 2090),
  last_source text not null default 'startup'
    check (last_source in ('startup', 'local', 'timeline', 'portal')),
  controller_process_started_at timestamptz,
  hardware_verification text not null default 'unavailable'
    check (hardware_verification in ('unavailable')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id),
  check (project_id = '44444444-4444-4444-8444-444444444441'::uuid),
  check (device_id = 'lighting:beagle')
);

insert into public.lighting_device_state (project_id, device_id, metadata)
values (
  '44444444-4444-4444-8444-444444444441'::uuid,
  'lighting:beagle',
  jsonb_build_object(
    'commissioning_state', 'bridge_pending',
    'legacy_source_unchanged', true,
    'hardware_owner', 'PhenoSystemControl.control.io.Control',
    'physical_readback_available', false,
    'portal_range_matches_local_gui', true
  )
)
on conflict (project_id, device_id) do nothing;

create table public.lighting_commands (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  intensity integer not null check (intensity = 0 or intensity between 10 and 255),
  expected_revision bigint not null check (expected_revision >= 0),
  idempotency_key uuid not null unique,
  status text not null default 'queued'
    check (status in ('queued', 'received', 'validated', 'applied', 'observed', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '20 seconds'),
  received_at timestamptz,
  validated_at timestamptz,
  applied_at timestamptz,
  observed_at timestamptz,
  completed_at timestamptz,
  controller_intensity numeric(8,3),
  error_message text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  check (expires_at <= created_at + interval '20 seconds')
);

create index lighting_commands_poll_idx
  on public.lighting_commands (project_id, device_id, status, created_at)
  where status in ('queued', 'received', 'validated');

create index lighting_commands_user_idx
  on public.lighting_commands (requested_by, created_at desc);

alter table public.lighting_agent_credentials enable row level security;
alter table public.lighting_device_state enable row level security;
alter table public.lighting_commands enable row level security;

revoke all on public.lighting_agent_credentials from public, anon, authenticated;
revoke all on public.lighting_device_state from public, anon, authenticated;
revoke all on public.lighting_commands from public, anon, authenticated;
grant select, insert, update on public.lighting_agent_credentials to service_role;
grant select, insert, update on public.lighting_device_state to service_role;
grant select, insert, update on public.lighting_commands to service_role;

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
     or not public.has_system_admin_installation_access(
       requested_project_id,
       requested_device_id,
       'remote_view'
     ) then
    raise exception 'System-admin installation access is required'
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
    'remote_control_allowed', public.has_system_admin_installation_access(
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

revoke all on function public.lighting_native_status(uuid, text) from public, anon;
grant execute on function public.lighting_native_status(uuid, text) to authenticated, service_role;

update public.project_platform_config
set
  capability_contract_version = '2026-09-01.chamber-control-lighting-v1',
  display_config = display_config || jsonb_build_object(
    'lighting_state', 'commissioning',
    'lighting_native_primary', true
  ),
  control_policy = control_policy || jsonb_build_object(
    'lighting_hardware_owner', 'legacy_java_control',
    'lighting_local_controls_preserved', true,
    'lighting_physical_readback_available', false,
    'lighting_command_chain', jsonb_build_array(
      'requested', 'received', 'validated', 'applied', 'controller_observed'
    )
  ),
  updated_at = now()
where project_id = '44444444-4444-4444-8444-444444444441'::uuid;

comment on table public.lighting_device_state is
  'Synchronized BEAGLE controller state. Controller observation is not a physical light-output measurement.';
comment on table public.lighting_commands is
  'Short-lived native lighting commands executed through the existing Java Control path.';
comment on function public.lighting_native_status(uuid, text) is
  'Fail-closed system-admin projection for native chamber lighting controls.';

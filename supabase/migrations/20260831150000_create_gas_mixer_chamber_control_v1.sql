-- ExactH2O chamber control: Gas Mixer Phase 1.
--
-- The existing Raspberry Pi mixer application remains the source of truth.
-- This migration only creates a system-admin installation boundary, device
-- heartbeat state, and short-lived remote-session audit records. It does not
-- add gas setpoints, MFC commands, GPIO writes, or a browser-to-device path.

do $$
declare
  chamber_organization_id constant uuid :=
    '44444444-4444-4444-8444-444444444440'::uuid;
  chamber_project_id constant uuid :=
    '44444444-4444-4444-8444-444444444441'::uuid;
  portal_project_id constant uuid :=
    '22222222-2222-4222-8222-222222222222'::uuid;
  selected_organization_id uuid;
begin
  select organization_id
  into selected_organization_id
  from public.projects
  where id = portal_project_id;

  if selected_organization_id is null then
    insert into public.organizations (id, slug, name)
    values (
      chamber_organization_id,
      'exacth2o-chamber-control',
      'ExactH2O Chamber Control'
    )
    on conflict (id) do nothing;
    selected_organization_id := chamber_organization_id;
  end if;

  insert into public.projects (id, organization_id, slug, name)
  values (
    chamber_project_id,
    selected_organization_id,
    'chamber-control',
    'Chamber Control'
  )
  on conflict (id) do nothing;
end;
$$;

insert into public.project_platform_config (
  project_id,
  capability_contract_version,
  display_config,
  control_policy,
  notification_policy
) values (
  '44444444-4444-4444-8444-444444444441'::uuid,
  '2026-08-31.chamber-control-gas-mixer-v1',
  jsonb_build_object(
    'system_admin_only', true,
    'modules', jsonb_build_array('gas_mixer', 'lighting'),
    'active_module', 'gas_mixer',
    'lighting_state', 'planned'
  ),
  jsonb_build_object(
    'mode', 'remote_existing_interface',
    'application_source_of_truth', 'physical_pi_session',
    'browser_direct_device_access', false,
    'single_controller', true,
    'default_session_mode', 'view',
    'max_session_seconds', 300
  ),
  '{}'::jsonb
)
on conflict (project_id) do update
set
  capability_contract_version = excluded.capability_contract_version,
  display_config = excluded.display_config,
  control_policy = excluded.control_policy,
  updated_at = now();

insert into public.research_sites (
  id,
  organization_id,
  project_id,
  slug,
  name,
  timezone,
  metadata
)
select
  '44444444-4444-4444-8444-444444444442'::uuid,
  project.organization_id,
  project.id,
  'gas-mixer-chamber',
  'Gas Mixer Chamber',
  'America/Detroit',
  jsonb_build_object(
    'device_class', 'raspberry_pi_3b_plus',
    'integration_phase', 'gas_mixer'
  )
from public.projects project
where project.id = '44444444-4444-4444-8444-444444444441'::uuid
on conflict (id) do nothing;

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
  'gas-mixer:b827eb548a44',
  project.organization_id,
  project.id,
  null,
  'Gas Mixer Raspberry Pi',
  'provisioning',
  null
from public.projects project
where project.id = '44444444-4444-4444-8444-444444444441'::uuid
on conflict (id) do nothing;

alter table public.system_admin_installation_access
  drop constraint if exists system_admin_installation_access_capability_check;

alter table public.system_admin_installation_access
  add constraint system_admin_installation_access_capability_check
  check (capability in ('observe', 'export', 'remote_view', 'remote_control'));

create table public.gas_mixer_device_status (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  connected boolean not null default false,
  last_heartbeat_at timestamptz,
  agent_version text,
  capture_backend text,
  local_session_available boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id),
  check (project_id = '44444444-4444-4444-8444-444444444441'::uuid),
  check (device_id = 'gas-mixer:b827eb548a44')
);

create table public.gas_mixer_agent_credentials (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  rotated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  primary key (project_id, device_id)
);

insert into public.gas_mixer_agent_credentials (
  project_id,
  device_id,
  token_hash,
  metadata
) values (
  '44444444-4444-4444-8444-444444444441'::uuid,
  'gas-mixer:b827eb548a44',
  '1ea7b8b4a7240af4883182edceee7a0cf3a993a50926ab5bcfab86d915244199',
  jsonb_build_object('credential_version', 1, 'created_for', 'gas_mixer_outbound_agent')
)
on conflict (project_id, device_id) do update
set
  token_hash = excluded.token_hash,
  enabled = true,
  rotated_at = now(),
  metadata = excluded.metadata;

insert into public.gas_mixer_device_status (project_id, device_id)
values (
  '44444444-4444-4444-8444-444444444441'::uuid,
  'gas-mixer:b827eb548a44'
)
on conflict (project_id, device_id) do nothing;

create table public.gas_mixer_remote_sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'view' check (mode in ('view', 'control')),
  status text not null default 'issued'
    check (status in ('issued', 'connected', 'ended', 'expired', 'revoked', 'failed')),
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default now(),
  connected_at timestamptz,
  last_activity_at timestamptz,
  expires_at timestamptz not null,
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  check (expires_at <= issued_at + interval '5 minutes')
);

create table public.gas_mixer_remote_commands (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  session_id uuid not null references public.gas_mixer_remote_sessions(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('tap')),
  normalized_x numeric not null check (normalized_x between 0 and 1),
  normalized_y numeric not null check (normalized_y between 0 and 1),
  status text not null default 'queued'
    check (status in ('queued', 'executed', 'failed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 seconds'),
  completed_at timestamptz,
  error_message text,
  check (expires_at <= created_at + interval '10 seconds')
);

create index gas_mixer_remote_commands_poll_idx
  on public.gas_mixer_remote_commands (project_id, device_id, status, created_at)
  where status = 'queued';

create unique index gas_mixer_single_active_controller_idx
  on public.gas_mixer_remote_sessions (project_id, device_id)
  where mode = 'control' and status in ('issued', 'connected');

create index gas_mixer_remote_sessions_user_idx
  on public.gas_mixer_remote_sessions (user_id, issued_at desc);

alter table public.gas_mixer_device_status enable row level security;
alter table public.gas_mixer_agent_credentials enable row level security;
alter table public.gas_mixer_remote_sessions enable row level security;
alter table public.gas_mixer_remote_commands enable row level security;

revoke all on public.gas_mixer_device_status from public, anon, authenticated;
revoke all on public.gas_mixer_agent_credentials from public, anon, authenticated;
revoke all on public.gas_mixer_remote_sessions from public, anon, authenticated;
revoke all on public.gas_mixer_remote_commands from public, anon, authenticated;
grant select, insert, update on public.gas_mixer_device_status to service_role;
grant select, insert, update on public.gas_mixer_agent_credentials to service_role;
grant select, insert, update on public.gas_mixer_remote_sessions to service_role;
grant select, insert, update on public.gas_mixer_remote_commands to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gas-mixer-frames',
  'gas-mixer-frames',
  false,
  524288,
  array['image/png']::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into public.system_admin_installation_access (
  project_id,
  device_id,
  portal_project_id,
  user_id,
  capability,
  metadata
)
select
  '44444444-4444-4444-8444-444444444441'::uuid,
  'gas-mixer:b827eb548a44',
  '22222222-2222-4222-8222-222222222222'::uuid,
  portal.user_id,
  capability.name,
  jsonb_build_object(
    'reason', 'Chamber Control Gas Mixer system-admin access',
    'email', lower(portal.email),
    'phase', 'gas_mixer'
  )
from public.portal_access portal
cross join (values ('remote_view'), ('remote_control')) as capability(name)
where portal.project_id = '22222222-2222-4222-8222-222222222222'::uuid
  and portal.role = 'admin'
on conflict (project_id, device_id, user_id, capability) do update
set
  enabled = true,
  revoked_at = null,
  metadata = excluded.metadata;

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
     or not public.has_system_admin_installation_access(
       requested_project_id,
       requested_device_id,
       'remote_view'
     ) then
    raise exception 'System-admin installation access is required'
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
      and role = 'admin'
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
    'remote_control_allowed', public.has_system_admin_installation_access(
      requested_project_id,
      requested_device_id,
      'remote_control'
    ),
    'active_session', active_session.id is not null,
    'active_controller_email', controller_email
  );
end;
$$;

revoke all on function public.gas_mixer_remote_status(uuid, text)
  from public, anon;
grant execute on function public.gas_mixer_remote_status(uuid, text)
  to authenticated, service_role;

comment on table public.gas_mixer_device_status is
  'Outbound agent heartbeat only. The physical mixer application remains authoritative.';
comment on table public.gas_mixer_agent_credentials is
  'Hashed device credential for the outbound-only mixer screen agent.';
comment on table public.gas_mixer_remote_sessions is
  'Short-lived, audited system-admin view/control sessions for the existing mixer interface.';
comment on table public.gas_mixer_remote_commands is
  'Short-lived normalized pointer events. No arbitrary shell, keyboard, setpoint, or GPIO commands.';
comment on function public.gas_mixer_remote_status(uuid, text) is
  'Fail-closed system-admin status projection for the Chamber Control Gas Mixer module.';

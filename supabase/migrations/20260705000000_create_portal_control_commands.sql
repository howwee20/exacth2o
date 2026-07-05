create extension if not exists pgcrypto with schema extensions;

create table if not exists public.project_control_commands (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  device_id text,
  command_type text not null check (
    command_type in (
      'update_pairing',
      'bulk_update_pairings',
      'create_pairing',
      'create_group',
      'remove_group',
      'create_calibration',
      'delete_calibration',
      'apply_calibration',
      'manual_water',
      'update_board_config',
      'initialize_sensors',
      'update_system_state',
      'export_data'
    )
  ),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (
    status in ('queued', 'accepted', 'running', 'succeeded', 'failed', 'canceled', 'expired')
  ),
  requested_by uuid not null references auth.users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  requires_confirmation boolean not null default false,
  confirmed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text,
  constraint project_control_commands_confirmation_check
    check (
      requires_confirmation = false
      or confirmed_at is not null
    )
);

create table if not exists public.project_control_audit (
  id uuid primary key default gen_random_uuid(),
  command_id uuid references public.project_control_commands(id) on delete set null,
  project_id uuid not null,
  device_id text,
  action text not null,
  actor_id uuid references auth.users(id) on delete set null,
  status text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.project_control_commands enable row level security;
alter table public.project_control_audit enable row level security;

revoke all on table public.project_control_commands from anon;
revoke all on table public.project_control_audit from anon;
revoke all on table public.project_control_commands from authenticated;
revoke all on table public.project_control_audit from authenticated;

grant select on table public.project_control_commands to authenticated;
grant select on table public.project_control_audit to authenticated;
grant select, insert, update on table public.project_control_commands to service_role;
grant select, insert, update on table public.project_control_audit to service_role;

create index if not exists project_control_commands_project_status_idx
  on public.project_control_commands (project_id, status, requested_at desc);

create index if not exists project_control_commands_device_status_idx
  on public.project_control_commands (device_id, status, requested_at asc)
  where status in ('queued', 'accepted', 'running');

create index if not exists project_control_commands_requested_by_idx
  on public.project_control_commands (requested_by, requested_at desc);

create index if not exists project_control_audit_project_created_idx
  on public.project_control_audit (project_id, created_at desc);

create policy "Project members can read control commands"
  on public.project_control_commands
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.project_members pm
      where pm.project_id = project_control_commands.project_id
        and pm.user_id = auth.uid()
    )
  );

create policy "Project members can read control audit"
  on public.project_control_audit
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.project_members pm
      where pm.project_id = project_control_audit.project_id
        and pm.user_id = auth.uid()
    )
  );

comment on table public.project_control_commands
  is 'Authenticated portal control requests. Edge Functions insert rows; device-side executors apply queued commands and write results.';

comment on table public.project_control_audit
  is 'Audit trail for portal control actions, including queued, accepted, applied, failed, and canceled events.';

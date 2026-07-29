-- Fail closed before a portal experiment is saved unless the device executor
-- has recently proved that it is live-ready and can read the local controller.
-- This migration does not change controller configuration or valve state.

create table if not exists public.device_control_executor_status (
  project_id uuid not null,
  device_id text not null,
  executor_version text not null,
  dry_run boolean not null,
  manual_water_enabled boolean not null default false,
  sync_ready boolean not null,
  local_api_reachable boolean not null,
  controller_state text,
  last_error text,
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id),
  constraint device_control_executor_status_state_check
    check (controller_state is null or controller_state in ('RUNNING', 'STOPPED')),
  constraint device_control_executor_status_device_id_check
    check (length(trim(device_id)) > 0),
  constraint device_control_executor_status_error_length_check
    check (last_error is null or length(last_error) <= 500)
);

alter table public.device_control_executor_status enable row level security;
revoke all on table public.device_control_executor_status
  from public, anon, authenticated;
grant select, insert, update on table public.device_control_executor_status
  to service_role;

create or replace function public.device_report_control_executor_status(
  device_token text,
  executor_version text,
  executor_dry_run boolean,
  executor_manual_water_enabled boolean,
  executor_sync_ready boolean,
  executor_local_api_reachable boolean,
  executor_controller_state text default null,
  executor_last_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  authorized_device public.device_control_tokens%rowtype;
  normalized_state text;
begin
  select *
  into authorized_device
  from public.device_control_tokens token
  where token.token_hash = encode(digest(coalesce(device_token, ''), 'sha256'), 'hex')
    and token.enabled = true
    and token.revoked_at is null
  limit 1;

  if authorized_device.project_id is null then
    raise exception 'Invalid device token';
  end if;
  if nullif(trim(coalesce(executor_version, '')), '') is null then
    raise exception 'Executor version is required';
  end if;

  normalized_state := upper(nullif(trim(coalesce(executor_controller_state, '')), ''));
  if normalized_state is not null and normalized_state not in ('RUNNING', 'STOPPED') then
    normalized_state := null;
  end if;

  insert into public.device_control_executor_status (
    project_id,
    device_id,
    executor_version,
    dry_run,
    manual_water_enabled,
    sync_ready,
    local_api_reachable,
    controller_state,
    last_error,
    observed_at,
    updated_at
  ) values (
    authorized_device.project_id,
    authorized_device.device_id,
    left(trim(executor_version), 160),
    coalesce(executor_dry_run, true),
    coalesce(executor_manual_water_enabled, false),
    coalesce(executor_sync_ready, false),
    coalesce(executor_local_api_reachable, false),
    normalized_state,
    left(nullif(trim(coalesce(executor_last_error, '')), ''), 500),
    now(),
    now()
  )
  on conflict (project_id, device_id)
  do update set
    executor_version = excluded.executor_version,
    dry_run = excluded.dry_run,
    manual_water_enabled = excluded.manual_water_enabled,
    sync_ready = excluded.sync_ready,
    local_api_reachable = excluded.local_api_reachable,
    controller_state = excluded.controller_state,
    last_error = excluded.last_error,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at;

  update public.device_control_tokens token
  set last_used_at = now()
  where token.id = authorized_device.id;
end;
$$;

revoke all on function public.device_report_control_executor_status(
  text, text, boolean, boolean, boolean, boolean, text, text
) from public;
grant execute on function public.device_report_control_executor_status(
  text, text, boolean, boolean, boolean, boolean, text, text
) to anon, authenticated;

comment on table public.device_control_executor_status is
  'Latest device-authenticated executor readiness heartbeat used to fail closed before controller-affecting portal work.';

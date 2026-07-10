-- This migration is intentionally additive. It does not alter controller configuration,
-- pairings, calibrations, targets, or valve state.

-- The migration runner must keep this lock and the following preflight check in
-- one transaction. It fences command inserts/claims during the schema cutover.
lock table public.project_control_commands in access exclusive mode;

do $$
begin
  if exists (
    select 1
    from public.project_control_commands
    where status in ('queued', 'accepted', 'running')
  ) then
    raise exception 'Control hardening migration requires zero queued, accepted, or running commands';
  end if;
end $$;

alter table public.project_control_commands
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists client_request_id uuid;

alter table public.device_control_tokens
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_reason text;

alter table public.device_health_snapshots
  add column if not exists observation_key text,
  add column if not exists ingest_complete boolean not null default true;

create index if not exists project_control_commands_running_lease_idx
  on public.project_control_commands (lease_expires_at)
  where status = 'running';

create unique index if not exists project_control_commands_client_request_idx
  on public.project_control_commands (project_id, requested_by, client_request_id)
  where client_request_id is not null;

create index if not exists device_health_snapshots_captured_at_idx
  on public.device_health_snapshots (captured_at);

create index if not exists sensor_readings_project_device_received_idx
  on public.sensor_readings (project_id, device_id, server_received_at desc, id desc);

create index if not exists sensor_readings_project_device_recorded_idx
  on public.sensor_readings (project_id, device_id, device_recorded_at desc, id desc);

create unique index if not exists device_health_snapshots_observation_idx
  on public.device_health_snapshots (project_id, device_id, observation_key)
  where observation_key is not null;

create index if not exists portal_access_user_project_idx
  on public.portal_access (user_id, project_id);

alter table public.portal_access
  drop constraint if exists portal_access_role_check;
alter table public.portal_access
  add constraint portal_access_role_check
  check (role in ('admin', 'researcher', 'viewer'));

create or replace function public.project_member_role_for_invite(invite_role text)
returns text
language sql
immutable
as $$
  select case invite_role
    when 'owner' then 'owner'
    when 'admin' then 'admin'
    when 'member' then 'researcher'
    when 'viewer' then 'viewer'
    else null
  end;
$$;

create or replace function public.portal_role_for_invite(invite_role text)
returns text
language sql
immutable
as $$
  select case invite_role
    when 'owner' then 'admin'
    when 'admin' then 'admin'
    when 'member' then 'researcher'
    when 'viewer' then 'viewer'
    else null
  end;
$$;

revoke all on function public.project_member_role_for_invite(text)
  from public, anon, authenticated;
revoke all on function public.portal_role_for_invite(text)
  from public, anon, authenticated;

create table if not exists public.device_control_quarantines (
  project_id uuid not null,
  device_id text not null,
  active boolean not null default true,
  command_id uuid references public.project_control_commands(id) on delete set null,
  reason text not null,
  quarantined_at timestamptz not null default now(),
  reconciled_at timestamptz,
  reconciliation_details jsonb not null default '{}'::jsonb,
  primary key (project_id, device_id)
);

alter table public.device_control_quarantines enable row level security;
revoke all on table public.device_control_quarantines from public, anon, authenticated;
grant select, insert, update on table public.device_control_quarantines to service_role;

create or replace function public.create_device_control_token(
  token_project_id uuid,
  token_device_id text,
  token_label text default null
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  raw_token text;
  safe_device_id text := trim(coalesce(token_device_id, ''));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may create device control tokens';
  end if;

  if safe_device_id = '' then
    raise exception 'A device ID is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(token_project_id::text || ':' || safe_device_id, 0)
  );

  if exists (
    select 1
    from public.device_control_quarantines quarantine
    where quarantine.project_id = token_project_id
      and quarantine.device_id = safe_device_id
      and quarantine.active = true
  ) then
    raise exception 'Cannot issue a token while the device command stream is quarantined';
  end if;

  raw_token := encode(gen_random_bytes(32), 'hex');

  insert into public.device_control_tokens (
    project_id,
    device_id,
    label,
    token_hash
  ) values (
    token_project_id,
    safe_device_id,
    nullif(trim(token_label), ''),
    encode(digest(raw_token, 'sha256'), 'hex')
  );

  return raw_token;
end;
$$;

revoke all on function public.create_device_control_token(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_device_control_token(uuid, text, text) to service_role;

create or replace function public.enqueue_portal_control_command(
  command_project_id uuid,
  command_device_id text,
  command_type text,
  command_payload jsonb,
  command_requested_by uuid,
  command_expires_at timestamptz,
  command_requires_confirmation boolean,
  command_confirmed_at timestamptz,
  command_client_request_id uuid
)
returns setof public.project_control_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  queued_command public.project_control_commands%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may enqueue portal control commands';
  end if;

  if command_device_id is null or trim(command_device_id) = '' then
    raise exception 'A device ID is required for control commands';
  end if;

  if command_client_request_id is null then
    raise exception 'A client request ID is required for control commands';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(command_project_id::text || ':' || trim(command_device_id), 0)
  );

  select pcc.*
  into queued_command
  from public.project_control_commands pcc
  where pcc.project_id = command_project_id
    and pcc.requested_by = command_requested_by
    and pcc.client_request_id = command_client_request_id
  limit 1;

  if queued_command.id is not null then
    return next queued_command;
    return;
  end if;

  if exists (
    select 1
    from public.device_control_quarantines quarantine
    where quarantine.project_id = command_project_id
      and quarantine.device_id = trim(command_device_id)
      and quarantine.active = true
  ) then
    raise exception 'Device command stream is disabled or quarantined';
  end if;

  if not exists (
    select 1
    from public.device_control_tokens dct
    where dct.project_id = command_project_id
      and dct.device_id = trim(command_device_id)
      and dct.enabled = true
      and dct.revoked_at is null
  ) then
    raise exception 'Device command stream has no enabled executor token';
  end if;

  if command_type = 'manual_water' and exists (
    select 1
    from public.project_control_commands pcc
    where pcc.project_id = command_project_id
      and pcc.device_id = trim(command_device_id)
      and pcc.command_type = 'manual_water'
      and (
        pcc.status = 'running'
        or (pcc.status in ('queued', 'accepted') and pcc.expires_at > now())
        or coalesce(pcc.completed_at, pcc.requested_at) > now() - interval '60 seconds'
      )
  ) then
    raise exception 'Manual watering is already active or cooling down for this device';
  end if;

  insert into public.project_control_commands (
    project_id,
    device_id,
    command_type,
    payload,
    requested_by,
    expires_at,
    requires_confirmation,
    confirmed_at,
    client_request_id
  ) values (
    command_project_id,
    trim(command_device_id),
    command_type,
    coalesce(command_payload, '{}'::jsonb),
    command_requested_by,
    command_expires_at,
    command_requires_confirmation,
    command_confirmed_at,
    command_client_request_id
  )
  returning * into queued_command;

  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    actor_id,
    status,
    details
  ) values (
    queued_command.id,
    command_project_id,
    trim(command_device_id),
    command_type,
    command_requested_by,
    'queued',
    jsonb_build_object(
      'payload', coalesce(command_payload, '{}'::jsonb),
      'requires_confirmation', command_requires_confirmation,
      'client_request_id', command_client_request_id
    )
  );

  return next queued_command;
end;
$$;

revoke all on function public.enqueue_portal_control_command(
  uuid, text, text, jsonb, uuid, timestamptz, boolean, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.enqueue_portal_control_command(
  uuid, text, text, jsonb, uuid, timestamptz, boolean, timestamptz, uuid
) to service_role;

-- All service-side mutations now go through the validated enqueue/lifecycle
-- functions below. This also prevents an older deployed Edge Function from
-- inserting commands directly during a coordinated cutover.
revoke insert, update, delete on table public.project_control_commands from service_role;
revoke insert, update, delete on table public.project_control_audit from service_role;
grant select on table public.project_control_commands to service_role;
grant select on table public.project_control_audit to service_role;

create or replace function public.device_claim_control_command(
  device_token text,
  executor_version text default null
)
returns table (
  id uuid,
  project_id uuid,
  device_id text,
  command_type text,
  payload jsonb,
  requested_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  authorized_device public.device_control_tokens%rowtype;
  claimed_id uuid;
  stale_count integer := 0;
begin
  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.token_hash = encode(digest(coalesce(device_token, ''), 'sha256'), 'hex')
    and dct.enabled = true
    and dct.revoked_at is null
  limit 1;

  if authorized_device.project_id is null then
    raise exception 'Invalid device token';
  end if;

  -- Serialize all enabled tokens/executor replicas for one physical device.
  perform pg_advisory_xact_lock(
    hashtextextended(authorized_device.project_id::text || ':' || authorized_device.device_id, 0)
  );

  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.id = authorized_device.id
    and dct.enabled = true
    and dct.revoked_at is null
  for update;

  if authorized_device.project_id is null then
    raise exception 'Device token was disabled while waiting for command lock';
  end if;

  if exists (
    select 1
    from public.device_control_quarantines quarantine
    where quarantine.project_id = authorized_device.project_id
      and quarantine.device_id = authorized_device.device_id
      and quarantine.active = true
  ) then
    raise exception 'Device command stream is quarantined';
  end if;

  update public.device_control_tokens dct
  set last_used_at = now()
  where dct.id = authorized_device.id;

  -- A timed-out hardware request is not fenceable from Postgres. Fail it, disable
  -- every token for the device, and require explicit state reconciliation before
  -- any later command can be claimed.
  with stale as (
    update public.project_control_commands pcc
    set
      status = 'failed',
      completed_at = now(),
      error = 'Command lease expired; device tokens disabled pending state reconciliation'
    where pcc.project_id = authorized_device.project_id
      and pcc.device_id = authorized_device.device_id
      and pcc.status = 'running'
      and (pcc.lease_expires_at is null or pcc.lease_expires_at <= now())
    returning pcc.id, pcc.project_id, pcc.device_id, pcc.lease_expires_at
  ), audited as (
    insert into public.project_control_audit (
      command_id,
      project_id,
      device_id,
      action,
      status,
      details
    )
    select
      stale.id,
      stale.project_id,
      stale.device_id,
      'device_lease_expired',
      'failed',
      jsonb_build_object(
        'lease_expires_at', stale.lease_expires_at,
        'requires_device_reconciliation', true
      )
    from stale
    returning 1
  )
  select count(*) into stale_count from audited;

  if stale_count > 0 then

    update public.device_control_tokens dct
    set enabled = false,
        disabled_at = now(),
        disabled_reason = 'command_lease_expired'
    where dct.project_id = authorized_device.project_id
      and dct.device_id = authorized_device.device_id
      and dct.revoked_at is null
      and dct.enabled = true;

    insert into public.device_control_quarantines (
      project_id,
      device_id,
      command_id,
      reason,
      active,
      quarantined_at,
      reconciled_at,
      reconciliation_details
    )
    select
      authorized_device.project_id,
      authorized_device.device_id,
      pcc.id,
      'Command lease expired; physical outcome requires reconciliation',
      true,
      now(),
      null,
      '{}'::jsonb
    from public.project_control_commands pcc
    where pcc.project_id = authorized_device.project_id
      and pcc.device_id = authorized_device.device_id
      and pcc.status = 'failed'
      and pcc.error = 'Command lease expired; device tokens disabled pending state reconciliation'
    order by pcc.completed_at desc
    limit 1
    on conflict (project_id, device_id) do update
    set command_id = excluded.command_id,
        reason = excluded.reason,
        active = true,
        quarantined_at = excluded.quarantined_at,
        reconciled_at = null,
        reconciliation_details = '{}'::jsonb;

    return;
  end if;

  if exists (
    select 1
    from public.project_control_commands pcc
    where pcc.project_id = authorized_device.project_id
      and pcc.device_id = authorized_device.device_id
      and pcc.status = 'running'
  ) then
    return;
  end if;

  update public.project_control_commands pcc
  set
    status = 'expired',
    completed_at = now(),
    lease_expires_at = null,
    error = 'Command expired before device executor claimed it'
  where pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
    and pcc.status in ('queued', 'accepted')
    and pcc.expires_at <= now();

  select pcc.id
  into claimed_id
  from public.project_control_commands pcc
  where pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
    and pcc.status in ('queued', 'accepted')
    and pcc.expires_at > now()
  order by pcc.requested_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.project_control_commands pcc
  set
    status = 'running',
    started_at = now(),
    lease_expires_at = now() + interval '2 minutes',
    attempt_count = pcc.attempt_count + 1,
    result = jsonb_build_object(
      'claimed_by', authorized_device.device_id,
      'executor_version', nullif(executor_version, ''),
      'claimed_at', now(),
      'lease_expires_at', now() + interval '2 minutes'
    )
  where pcc.id = claimed_id;

  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    status,
    details
  )
  select
    pcc.id,
    pcc.project_id,
    pcc.device_id,
    'device_claim',
    'running',
    jsonb_build_object(
      'executor_version', nullif(executor_version, ''),
      'lease_expires_at', pcc.lease_expires_at,
      'attempt_count', pcc.attempt_count
    )
  from public.project_control_commands pcc
  where pcc.id = claimed_id;

  return query
  select
    pcc.id,
    pcc.project_id,
    pcc.device_id,
    pcc.command_type,
    pcc.payload,
    pcc.requested_at,
    pcc.expires_at
  from public.project_control_commands pcc
  where pcc.id = claimed_id;
end;
$$;

create or replace function public.device_renew_control_command_lease(
  device_token text,
  command_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  authorized_device public.device_control_tokens%rowtype;
  updated_count integer;
begin
  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.token_hash = encode(digest(coalesce(device_token, ''), 'sha256'), 'hex')
    and dct.enabled = true
    and dct.revoked_at is null
  limit 1;

  if authorized_device.project_id is null then
    raise exception 'Invalid device token';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(authorized_device.project_id::text || ':' || authorized_device.device_id, 0)
  );

  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.id = authorized_device.id
    and dct.enabled = true
    and dct.revoked_at is null
  for update;

  if authorized_device.project_id is null then
    raise exception 'Device token was disabled while waiting for command lock';
  end if;

  update public.project_control_commands pcc
  set lease_expires_at = now() + interval '2 minutes'
  where pcc.id = command_id
    and pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
    and pcc.status = 'running'
    and pcc.lease_expires_at > now();

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.device_renew_control_command_lease(text, uuid) from public;
grant execute on function public.device_renew_control_command_lease(text, uuid) to anon, authenticated;

create or replace function public.device_quarantine_control_command(
  device_token text,
  command_id uuid,
  quarantine_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  authorized_device public.device_control_tokens%rowtype;
  current_status text;
  safe_reason text := left(coalesce(nullif(trim(quarantine_reason), ''), 'Controller mutation outcome is unknown'), 1000);
begin
  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.token_hash = encode(digest(coalesce(device_token, ''), 'sha256'), 'hex')
    and dct.revoked_at is null
  limit 1;

  if authorized_device.project_id is null then
    raise exception 'Invalid device token';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(authorized_device.project_id::text || ':' || authorized_device.device_id, 0)
  );

  select pcc.status
  into current_status
  from public.project_control_commands pcc
  where pcc.id = command_id
    and pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
  for update;

  if current_status is null then
    raise exception 'Command does not belong to this device';
  end if;

  if current_status in ('succeeded', 'failed', 'canceled', 'expired') then
    return jsonb_build_object('ok', true, 'status', current_status, 'already_terminal', true);
  end if;

  if current_status <> 'running' then
    raise exception 'Only a running command can be quarantined';
  end if;

  update public.project_control_commands pcc
  set status = 'failed',
      completed_at = now(),
      lease_expires_at = null,
      error = safe_reason,
      result = coalesce(pcc.result, '{}'::jsonb) || jsonb_build_object(
        'requires_device_reconciliation', true,
        'quarantined_at', now()
      )
  where pcc.id = command_id;

  update public.device_control_tokens dct
  set enabled = false,
      disabled_at = now(),
      disabled_reason = 'command_quarantine'
  where dct.project_id = authorized_device.project_id
    and dct.device_id = authorized_device.device_id
    and dct.revoked_at is null
    and dct.enabled = true;

  insert into public.device_control_quarantines (
    project_id,
    device_id,
    command_id,
    reason,
    active,
    quarantined_at,
    reconciled_at,
    reconciliation_details
  ) values (
    authorized_device.project_id,
    authorized_device.device_id,
    command_id,
    safe_reason,
    true,
    now(),
    null,
    '{}'::jsonb
  )
  on conflict (project_id, device_id) do update
  set command_id = excluded.command_id,
      reason = excluded.reason,
      active = true,
      quarantined_at = excluded.quarantined_at,
      reconciled_at = null,
      reconciliation_details = '{}'::jsonb;

  with canceled as (
    update public.project_control_commands pcc
    set status = 'canceled',
        completed_at = now(),
        lease_expires_at = null,
        error = 'Canceled because the device command stream requires reconciliation'
    where pcc.project_id = authorized_device.project_id
      and pcc.device_id = authorized_device.device_id
      and pcc.status in ('queued', 'accepted')
    returning pcc.id, pcc.project_id, pcc.device_id
  )
  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    status,
    details
  )
  select
    canceled.id,
    canceled.project_id,
    canceled.device_id,
    'device_quarantine_cancel_pending',
    'canceled',
    jsonb_build_object('requires_resubmission', true)
  from canceled;

  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    status,
    details
  ) values (
    command_id,
    authorized_device.project_id,
    authorized_device.device_id,
    'device_quarantine',
    'failed',
    jsonb_build_object(
      'reason', safe_reason,
      'requires_device_reconciliation', true
    )
  );

  return jsonb_build_object('ok', true, 'status', 'failed', 'quarantined', true);
end;
$$;

revoke all on function public.device_quarantine_control_command(text, uuid, text) from public;
grant execute on function public.device_quarantine_control_command(text, uuid, text) to anon, authenticated;

create or replace function public.reconcile_device_control_quarantine(
  reconcile_project_id uuid,
  reconcile_device_id text,
  observed_at timestamptz,
  confirmed_valves_closed boolean,
  observed_state jsonb,
  reconciliation_note text,
  reenable_commands boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  enabled_count integer := 0;
  canceled_count integer := 0;
  safe_device_id text := trim(coalesce(reconcile_device_id, ''));
  safe_note text := left(trim(coalesce(reconciliation_note, '')), 1000);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may reconcile a quarantined device';
  end if;

  if safe_device_id = '' then
    raise exception 'A device ID is required';
  end if;

  if observed_at is null or observed_at < now() - interval '5 minutes' or observed_at > now() + interval '1 minute' then
    raise exception 'A fresh device observation is required';
  end if;

  if confirmed_valves_closed is not true then
    raise exception 'All valves must be independently confirmed closed';
  end if;

  if jsonb_typeof(coalesce(observed_state, '{}'::jsonb)) <> 'object' then
    raise exception 'Observed state must be a JSON object';
  end if;

  if upper(coalesce(observed_state->>'controller_state', '')) <> 'STOPPED' then
    raise exception 'Observed controller state must be STOPPED';
  end if;

  if length(trim(coalesce(observed_state->>'verification', ''))) < 5 then
    raise exception 'Observed state must include independent verification evidence';
  end if;

  if length(safe_note) < 10 then
    raise exception 'A reconciliation note is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(reconcile_project_id::text || ':' || safe_device_id, 0)
  );

  if not exists (
    select 1
    from public.device_control_quarantines quarantine
    where quarantine.project_id = reconcile_project_id
      and quarantine.device_id = safe_device_id
      and quarantine.active = true
  ) then
    raise exception 'Device command stream is not actively quarantined';
  end if;

  if exists (
    select 1
    from public.project_control_commands pcc
    where pcc.project_id = reconcile_project_id
      and pcc.device_id = safe_device_id
      and pcc.status = 'running'
  ) then
    raise exception 'A running command still exists for this device';
  end if;

  insert into public.project_control_audit (
    project_id,
    device_id,
    action,
    status,
    details
  ) values (
    reconcile_project_id,
    safe_device_id,
    'device_reconcile',
    case when reenable_commands then 'reenabled' else 'verified' end,
    jsonb_build_object(
      'observed_at', observed_at,
      'confirmed_valves_closed', confirmed_valves_closed,
      'observed_state', coalesce(observed_state, '{}'::jsonb),
      'note', safe_note,
      'reenable_commands', reenable_commands
    )
  );

  update public.device_control_quarantines quarantine
  set active = not reenable_commands,
      reconciled_at = case when reenable_commands then now() else null end,
      reconciliation_details = jsonb_build_object(
        'observed_at', observed_at,
        'confirmed_valves_closed', confirmed_valves_closed,
        'observed_state', coalesce(observed_state, '{}'::jsonb),
        'note', safe_note,
        'reenable_commands', reenable_commands
      )
  where quarantine.project_id = reconcile_project_id
    and quarantine.device_id = safe_device_id
    and quarantine.active = true;

  if reenable_commands then
    with canceled as (
      update public.project_control_commands pcc
      set status = 'canceled',
          completed_at = now(),
          lease_expires_at = null,
          error = 'Canceled during device reconciliation; resubmit after verification'
      where pcc.project_id = reconcile_project_id
        and pcc.device_id = safe_device_id
        and pcc.status in ('queued', 'accepted')
      returning pcc.id, pcc.project_id, pcc.device_id
    ), audited as (
      insert into public.project_control_audit (
        command_id,
        project_id,
        device_id,
        action,
        status,
        details
      )
      select
        canceled.id,
        canceled.project_id,
        canceled.device_id,
        'device_reconcile_cancel_pending',
        'canceled',
        jsonb_build_object('requires_resubmission', true)
      from canceled
      returning 1
    )
    select count(*) into canceled_count from audited;

    update public.device_control_tokens dct
    set enabled = true,
        disabled_at = null,
        disabled_reason = null
    where dct.project_id = reconcile_project_id
      and dct.device_id = safe_device_id
      and dct.revoked_at is null
      and dct.enabled = false
      and dct.disabled_reason in ('command_quarantine', 'command_lease_expired');
    get diagnostics enabled_count = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'reenabled', reenable_commands,
    'enabled_token_count', enabled_count,
    'canceled_pending_count', canceled_count
  );
end;
$$;

revoke all on function public.reconcile_device_control_quarantine(
  uuid, text, timestamptz, boolean, jsonb, text, boolean
) from public, anon, authenticated;
grant execute on function public.reconcile_device_control_quarantine(
  uuid, text, timestamptz, boolean, jsonb, text, boolean
) to service_role;

create or replace function public.device_complete_control_command(
  device_token text,
  command_id uuid,
  final_status text,
  command_result jsonb default '{}'::jsonb,
  command_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  authorized_device public.device_control_tokens%rowtype;
  updated_count integer;
  current_status text;
begin
  if final_status not in ('succeeded', 'failed', 'canceled') then
    raise exception 'Invalid final status';
  end if;

  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.token_hash = encode(digest(coalesce(device_token, ''), 'sha256'), 'hex')
    and dct.enabled = true
    and dct.revoked_at is null
  limit 1;

  if authorized_device.project_id is null then
    raise exception 'Invalid device token';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(authorized_device.project_id::text || ':' || authorized_device.device_id, 0)
  );

  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.id = authorized_device.id
    and dct.enabled = true
    and dct.revoked_at is null
  for update;

  if authorized_device.project_id is null then
    raise exception 'Device token was disabled while waiting for command lock';
  end if;

  select pcc.status
  into current_status
  from public.project_control_commands pcc
  where pcc.id = command_id
    and pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
  for update;

  if current_status in ('succeeded', 'failed', 'canceled', 'expired') then
    return jsonb_build_object('ok', true, 'status', current_status, 'already_terminal', true);
  end if;

  update public.device_control_tokens dct
  set last_used_at = now()
  where dct.id = authorized_device.id;

  update public.project_control_commands pcc
  set
    status = final_status,
    completed_at = now(),
    lease_expires_at = null,
    result = coalesce(command_result, '{}'::jsonb),
    error = nullif(command_error, '')
  where pcc.id = command_id
    and pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
    and pcc.status = 'running'
    and pcc.lease_expires_at > now();

  get diagnostics updated_count = row_count;

  if updated_count <> 1 then
    raise exception 'Command is not running for this device';
  end if;

  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    status,
    details
  )
  values (
    command_id,
    authorized_device.project_id,
    authorized_device.device_id,
    'device_complete',
    final_status,
    jsonb_build_object(
      'result', coalesce(command_result, '{}'::jsonb),
      'error', nullif(command_error, '')
    )
  );

  return jsonb_build_object('ok', true, 'status', final_status);
end;
$$;

create table if not exists public.device_ingest_leases (
  project_id uuid not null,
  device_id text not null,
  holder uuid not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id)
);

alter table public.device_ingest_leases enable row level security;
revoke all on table public.device_ingest_leases from public, anon, authenticated;
grant select, insert, update, delete on table public.device_ingest_leases to service_role;

create or replace function public.acquire_device_ingest_lease(
  lease_project_id uuid,
  lease_device_id text,
  lease_holder uuid,
  lease_seconds integer default 90
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may acquire ingest leases';
  end if;

  insert into public.device_ingest_leases (
    project_id,
    device_id,
    holder,
    expires_at,
    updated_at
  ) values (
    lease_project_id,
    trim(lease_device_id),
    lease_holder,
    now() + make_interval(secs => least(greatest(lease_seconds, 15), 300)),
    now()
  )
  on conflict (project_id, device_id) do update
  set holder = excluded.holder,
      expires_at = excluded.expires_at,
      updated_at = now()
  where public.device_ingest_leases.expires_at <= now()
     or public.device_ingest_leases.holder = excluded.holder;

  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

create or replace function public.release_device_ingest_lease(
  lease_project_id uuid,
  lease_device_id text,
  lease_holder uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may release ingest leases';
  end if;

  delete from public.device_ingest_leases
  where project_id = lease_project_id
    and device_id = trim(lease_device_id)
    and holder = lease_holder;

  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;

revoke all on function public.acquire_device_ingest_lease(uuid, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_device_ingest_lease(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_device_ingest_lease(uuid, text, uuid, integer) to service_role;
grant execute on function public.release_device_ingest_lease(uuid, text, uuid) to service_role;

create or replace function public.prune_device_health_history(retention_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may prune device health history';
  end if;

  delete from public.device_health_snapshots
  where captured_at < now() - make_interval(days => least(greatest(retention_days, 1), 365));

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.prune_device_health_history(integer) from public, anon, authenticated;
grant execute on function public.prune_device_health_history(integer) to service_role;

create table if not exists public.device_maintenance_state (
  task_name text primary key,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  details jsonb not null default '{}'::jsonb
);

alter table public.device_maintenance_state enable row level security;
revoke all on table public.device_maintenance_state from public, anon, authenticated;
grant select, insert, update on table public.device_maintenance_state to service_role;

create or replace function public.run_device_health_retention(
  retention_days integer default 30,
  minimum_interval_hours integer default 23
)
returns table (ran boolean, deleted_rows integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  last_completed timestamptz;
  deleted_count integer := 0;
  safe_interval integer := least(greatest(minimum_interval_hours, 1), 168);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may run device health retention';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('device-health-retention', 0));

  select state.last_completed_at
  into last_completed
  from public.device_maintenance_state state
  where state.task_name = 'device_health_retention';

  if last_completed is not null
     and last_completed > now() - make_interval(hours => safe_interval) then
    return query select false, 0;
    return;
  end if;

  insert into public.device_maintenance_state (task_name, last_started_at)
  values ('device_health_retention', now())
  on conflict (task_name) do update
  set last_started_at = excluded.last_started_at;

  deleted_count := public.prune_device_health_history(retention_days);

  update public.device_maintenance_state
  set last_completed_at = now(),
      details = jsonb_build_object(
        'retention_days', least(greatest(retention_days, 1), 365),
        'deleted_rows', deleted_count
      )
  where task_name = 'device_health_retention';

  return query select true, deleted_count;
end;
$$;

revoke all on function public.run_device_health_retention(integer, integer)
  from public, anon, authenticated;
grant execute on function public.run_device_health_retention(integer, integer)
  to service_role;

-- Set-returning membership helpers are evaluated once by InitPlan instead of once
-- per protected row when policies use them through a SELECT.
create or replace function public.portal_project_ids()
returns table (allowed_project_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select pa.project_id
  from public.portal_access pa
  where pa.user_id = (select auth.uid());
$$;

create or replace function public.portal_admin_project_ids()
returns table (allowed_project_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select pa.project_id
  from public.portal_access pa
  where pa.user_id = (select auth.uid())
    and pa.role = 'admin';
$$;

revoke all on function public.portal_project_ids() from public, anon;
revoke all on function public.portal_admin_project_ids() from public, anon;
grant execute on function public.portal_project_ids() to authenticated, service_role;
grant execute on function public.portal_admin_project_ids() to authenticated, service_role;

-- Preserve the original project_members authorization boundary while avoiding
-- a security-definer membership function call for every protected data row.
create or replace function public.member_project_ids()
returns table (allowed_project_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select membership.project_id
  from public.project_members membership
  where membership.user_id = (select auth.uid());
$$;

create or replace function public.member_organization_ids()
returns table (allowed_organization_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct project.organization_id
  from public.projects project
  join public.project_members membership
    on membership.project_id = project.id
  where membership.user_id = (select auth.uid());
$$;

revoke all on function public.member_project_ids() from public, anon;
revoke all on function public.member_organization_ids() from public, anon;
grant execute on function public.member_project_ids() to authenticated, service_role;
grant execute on function public.member_organization_ids() to authenticated, service_role;

drop policy if exists "members read devices" on public.devices;
create policy "members read devices"
  on public.devices
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.member_project_ids()));

drop policy if exists "members read latest device state" on public.latest_device_state;
create policy "members read latest device state"
  on public.latest_device_state
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.member_project_ids()));

drop policy if exists "members read organizations" on public.organizations;
create policy "members read organizations"
  on public.organizations
  for select
  to authenticated
  using (id in (select allowed_organization_id from public.member_organization_ids()));

drop policy if exists "members read pairings" on public.pairings;
create policy "members read pairings"
  on public.pairings
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.member_project_ids()));

drop policy if exists "members read projects" on public.projects;
create policy "members read projects"
  on public.projects
  for select
  to authenticated
  using (id in (select allowed_project_id from public.member_project_ids()));

drop policy if exists "members read sensor readings" on public.sensor_readings;
create policy "members read sensor readings"
  on public.sensor_readings
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.member_project_ids()));

drop policy if exists "members read sensors" on public.sensors;
create policy "members read sensors"
  on public.sensors
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.member_project_ids()));

create or replace function public.apply_project_invite_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  project_member_role text := public.project_member_role_for_invite(new.role);
  portal_role text := public.portal_role_for_invite(new.role);
begin
  if new.accepted_at is null or new.accepted_by is null then
    return new;
  end if;

  if project_member_role is null or portal_role is null then
    raise exception 'Unsupported project invite role: %', new.role;
  end if;

  insert into public.profiles (id, email, full_name)
  values (
    new.accepted_by,
    lower(trim(new.email)),
    public.invite_profile_name(new.email)
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(public.profiles.full_name, excluded.full_name);

  insert into public.project_members (project_id, user_id, role)
  values (new.project_id, new.accepted_by, project_member_role)
  on conflict (project_id, user_id) do update
  set role = excluded.role;

  insert into public.portal_access (project_id, user_id, email, role)
  values (
    new.project_id,
    new.accepted_by,
    lower(trim(new.email)),
    portal_role
  )
  on conflict (project_id, user_id) do update
  set email = excluded.email,
      role = excluded.role,
      updated_at = now();

  return new;
end;
$$;

-- Reconcile accepted invitees with the explicit invite-to-access role contract.
with accepted_invites as (
  select distinct on (invite.project_id, invite.accepted_by)
    invite.project_id,
    invite.accepted_by as user_id,
    lower(trim(invite.email)) as email,
    public.project_member_role_for_invite(invite.role) as project_member_role,
    public.portal_role_for_invite(invite.role) as portal_role
  from public.project_invites invite
  where invite.accepted_at is not null
    and invite.accepted_by is not null
  order by invite.project_id, invite.accepted_by, invite.accepted_at desc
)
insert into public.project_members (project_id, user_id, role)
select project_id, user_id, project_member_role
from accepted_invites
where project_member_role is not null
on conflict (project_id, user_id) do update
set role = excluded.role;

with accepted_invites as (
  select distinct on (invite.project_id, invite.accepted_by)
    invite.project_id,
    invite.accepted_by as user_id,
    lower(trim(invite.email)) as email,
    public.portal_role_for_invite(invite.role) as portal_role
  from public.project_invites invite
  where invite.accepted_at is not null
    and invite.accepted_by is not null
  order by invite.project_id, invite.accepted_by, invite.accepted_at desc
)
insert into public.portal_access (project_id, user_id, email, role)
select project_id, user_id, email, portal_role
from accepted_invites
where portal_role is not null
on conflict (project_id, user_id) do update
set email = excluded.email,
    role = excluded.role,
    updated_at = now();

drop policy if exists "Users can read their portal access" on public.portal_access;
create policy "Users can read their portal access"
  on public.portal_access
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or project_id in (select allowed_project_id from public.portal_admin_project_ids())
  );

drop policy if exists "Portal admins can read control commands" on public.project_control_commands;
drop policy if exists "Portal members can read control commands" on public.project_control_commands;
create policy "Portal members can read control commands"
  on public.project_control_commands
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.portal_project_ids()));

drop policy if exists "Portal admins can read control audit" on public.project_control_audit;
drop policy if exists "Portal members can read control audit" on public.project_control_audit;
create policy "Portal members can read control audit"
  on public.project_control_audit
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.portal_project_ids()));

drop policy if exists "Portal admins can read device health snapshots" on public.device_health_snapshots;
create policy "Portal admins can read device health snapshots"
  on public.device_health_snapshots
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.portal_admin_project_ids()));

drop policy if exists "Portal members can read device runtime state" on public.device_runtime_state;
create policy "Portal members can read device runtime state"
  on public.device_runtime_state
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.portal_project_ids()));

drop policy if exists "Portal members can read device config state" on public.device_config_state;
create policy "Portal members can read device config state"
  on public.device_config_state
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.portal_project_ids()));

drop policy if exists "Portal members can read valve events" on public.valve_events;
drop policy if exists "Project members can read valve events" on public.valve_events;
drop policy if exists "members read valve events" on public.valve_events;
drop policy if exists "Members can read valve events" on public.valve_events;
create policy "Members can read valve events"
  on public.valve_events
  for select
  to authenticated
  using (project_id in (select allowed_project_id from public.member_project_ids()));

comment on column public.project_control_commands.lease_expires_at
  is 'Fail-closed executor lease. Expired running commands are marked failed and are never automatically replayed.';

comment on function public.device_renew_control_command_lease(text, uuid)
  is 'Extends a still-valid running command lease for the device that owns the command.';

comment on table public.device_ingest_leases
  is 'Short service-role leases that debounce concurrent health ingestion authorities.';

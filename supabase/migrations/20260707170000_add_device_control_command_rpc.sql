create extension if not exists pgcrypto with schema extensions;

create table if not exists public.device_control_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  device_id text not null,
  label text,
  token_hash text not null unique,
  enabled boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint device_control_tokens_device_id_check
    check (length(trim(device_id)) > 0)
);

alter table public.device_control_tokens enable row level security;

revoke all on table public.device_control_tokens from anon;
revoke all on table public.device_control_tokens from authenticated;
grant select, insert, update on table public.device_control_tokens to service_role;

create index if not exists device_control_tokens_project_device_idx
  on public.device_control_tokens (project_id, device_id)
  where enabled = true and revoked_at is null;

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
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only service_role may create device control tokens';
  end if;

  raw_token := encode(gen_random_bytes(32), 'hex');

  insert into public.device_control_tokens (
    project_id,
    device_id,
    label,
    token_hash
  ) values (
    token_project_id,
    trim(token_device_id),
    nullif(trim(token_label), ''),
    encode(digest(raw_token, 'sha256'), 'hex')
  );

  return raw_token;
end;
$$;

revoke all on function public.create_device_control_token(uuid, text, text) from public;
grant execute on function public.create_device_control_token(uuid, text, text) to service_role;

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

  update public.device_control_tokens dct
  set last_used_at = now()
  where dct.id = authorized_device.id;

  update public.project_control_commands pcc
  set
    status = 'expired',
    completed_at = now(),
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
    result = jsonb_build_object(
      'claimed_by', authorized_device.device_id,
      'executor_version', nullif(executor_version, ''),
      'claimed_at', now()
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
    jsonb_build_object('executor_version', nullif(executor_version, ''))
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

revoke all on function public.device_claim_control_command(text, text) from public;
grant execute on function public.device_claim_control_command(text, text) to anon, authenticated;

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

  update public.device_control_tokens dct
  set last_used_at = now()
  where dct.id = authorized_device.id;

  update public.project_control_commands pcc
  set
    status = final_status,
    completed_at = now(),
    result = coalesce(command_result, '{}'::jsonb),
    error = nullif(command_error, '')
  where pcc.id = command_id
    and pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
    and pcc.status = 'running';

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

revoke all on function public.device_complete_control_command(text, uuid, text, jsonb, text) from public;
grant execute on function public.device_complete_control_command(text, uuid, text, jsonb, text) to anon, authenticated;

comment on table public.device_control_tokens
  is 'Hashed device tokens used by controller-side command executors. Raw tokens are shown once and are never stored.';

comment on function public.device_claim_control_command(text, text)
  is 'Claims one queued control command for the device identified by a device token. Intended for Balena-side executors using the anon key, not service_role.';

comment on function public.device_complete_control_command(text, uuid, text, jsonb, text)
  is 'Completes a running control command after the Balena-side executor applies or rejects it locally.';

-- No controller settings or experiment rows are changed. Guards apply to future commands only.
create table public.control_command_intake_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.control_command_intake_settings enable row level security;
revoke all on public.control_command_intake_settings from public, anon, authenticated;
grant select, update on public.control_command_intake_settings to service_role;
insert into public.control_command_intake_settings(singleton,enabled) values (true,true);
comment on table public.control_command_intake_settings is 'Shared command intake gate. Disabling blocks all enqueue RPCs; it does not stop already-running hardware.';

create function public.assert_portal_command_access(project uuid, actor uuid, action text)
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

  perform public.assert_portal_command_access(command_project_id, command_requested_by, command_type);

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


-- Portal access is the current authority. A stale legacy membership cannot retain telemetry access.
create or replace function public.member_project_ids()
returns table(allowed_project_id uuid) language sql stable security definer set search_path=public as $$
  select pa.project_id from public.portal_access pa
  where pa.user_id=(select auth.uid()) and pa.access_scope='project';
$$;
create or replace function public.member_organization_ids()
returns table(allowed_organization_id uuid) language sql stable security definer set search_path=public as $$
  select distinct p.organization_id from public.projects p
  join public.portal_access pa on pa.project_id=p.id
  where pa.user_id=(select auth.uid()) and pa.access_scope='project';
$$;

-- Existing roles and invitations are retained. Future invitations default to researcher.
alter table public.project_invites alter column role set default 'member';

create or replace function public.create_project_invite(
  invitee_email text,
  invited_project_id uuid default '22222222-2222-4222-8222-222222222222'::uuid,
  invite_role text default 'member',
  invite_expires_at timestamptz default now() + interval '14 days'
)
returns table (
  invite_id uuid,
  email text,
  project_id uuid,
  role text,
  invite_url text,
  raw_token text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  clean_email text := lower(trim(invitee_email));
  generated_token text := encode(gen_random_bytes(32), 'hex');
  inserted_id uuid;
begin
  if clean_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Invalid invite email';
  end if;

  if invite_role not in ('owner', 'admin', 'member', 'viewer') then
    raise exception 'Invalid invite role';
  end if;

  if invite_expires_at <= now() then
    raise exception 'Invite expiry must be in the future';
  end if;

  insert into public.project_invites (
    token_hash,
    project_id,
    email,
    role,
    expires_at,
    created_by
  )
  values (
    encode(digest(generated_token, 'sha256'), 'hex'),
    invited_project_id,
    clean_email,
    invite_role,
    invite_expires_at,
    auth.uid()
  )
  returning id into inserted_id;

  return query
  select
    inserted_id,
    clean_email,
    invited_project_id,
    invite_role,
    'https://exacth2o.com/portal.html?invite=' || generated_token,
    generated_token,
    invite_expires_at;
end;
$$;

alter policy "project members create calibration studies" on public.calibration_studies
  with check (public.has_portal_project_role(project_id,array['admin','researcher']) and created_by=(select auth.uid()));

alter policy "project members create calibration observations" on public.calibration_observations
  with check (public.has_portal_project_role(project_id,array['admin','researcher']) and created_by=(select auth.uid()));

alter policy "project members create calibration candidates" on public.calibration_candidates
  with check (public.has_portal_project_role(project_id,array['admin','researcher']) and created_by=(select auth.uid()));
alter policy "study owners manage calibration studies" on public.calibration_studies using (public.has_portal_project_role(project_id,array['admin','researcher']) and (created_by=(select auth.uid()) or public.has_portal_project_role(project_id,array['admin']))) with check (public.has_portal_project_role(project_id,array['admin','researcher']) and (created_by=(select auth.uid()) or public.has_portal_project_role(project_id,array['admin'])));
alter policy "observation owners manage calibration observations" on public.calibration_observations using (public.has_portal_project_role(project_id,array['admin','researcher']) and (created_by=(select auth.uid()) or public.has_portal_project_role(project_id,array['admin']))) with check (public.has_portal_project_role(project_id,array['admin','researcher']) and (created_by=(select auth.uid()) or public.has_portal_project_role(project_id,array['admin'])));
alter policy "observation owners delete calibration observations" on public.calibration_observations
  using (public.has_portal_project_role(project_id,array['admin','researcher']) and (created_by=(select auth.uid()) or public.has_portal_project_role(project_id,array['admin'])));

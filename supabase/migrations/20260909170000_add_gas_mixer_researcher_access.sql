-- Native mixer access is independent of irrigation membership and admin diagnostics.
alter table public.portal_access add column access_scope text not null default 'project'
  check (access_scope in ('project', 'gas_mixer'));
alter table public.project_invites add column access_scope text not null default 'project'
  check (access_scope in ('project', 'gas_mixer'));
alter table public.project_invites add constraint gas_mixer_invite_scope
  check (access_scope <> 'gas_mixer' or (project_id = '44444444-4444-4444-8444-444444444441'::uuid and role = 'member'));
alter table public.portal_access add constraint gas_mixer_portal_scope
  check (access_scope <> 'gas_mixer' or (project_id = '44444444-4444-4444-8444-444444444441'::uuid and role = 'researcher'));

create table public.gas_mixer_researcher_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  can_control boolean not null default false,
  enabled boolean not null default true,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.gas_mixer_researcher_access enable row level security;
revoke all on public.gas_mixer_researcher_access from public, anon, authenticated;
grant select, insert, update, delete on public.gas_mixer_researcher_access to service_role;

create or replace function public.has_gas_mixer_native_access(
  check_project_id uuid, check_device_id text, check_capability text default 'remote_view'
) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    check_project_id = '44444444-4444-4444-8444-444444444441'::uuid
    and check_device_id = 'gas-mixer:b827eb548a44'
    and check_capability in ('remote_view', 'remote_control')
    and (public.has_system_admin_installation_access(check_project_id, check_device_id, check_capability)
      or exists (
        select 1 from public.gas_mixer_researcher_access a
        where a.user_id = auth.uid() and a.enabled and a.revoked_at is null
          and (check_capability = 'remote_view' or a.can_control)
          and exists (select 1 from public.portal_access p where p.user_id = a.user_id and p.role in ('researcher', 'admin'))
      )), false);
$$;
revoke all on function public.has_gas_mixer_native_access(uuid,text,text) from public, anon;
grant execute on function public.has_gas_mixer_native_access(uuid,text,text) to authenticated, service_role;

-- A mixer-only portal row never counts as irrigation project access.
create or replace function public.portal_project_ids()
returns table(allowed_project_id uuid) language sql stable security definer set search_path = public as $$
  select pa.project_id from public.portal_access pa
  where pa.user_id = (select auth.uid()) and pa.access_scope = 'project';
$$;

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

  if new.access_scope = 'gas_mixer' then
    if new.expires_at <= now() or not exists (
      select 1 from auth.users u where u.id = new.accepted_by and lower(u.email) = new.email
    ) then
      raise exception 'Mixer invitation identity or expiration is invalid';
    end if;
    insert into public.portal_access (project_id, user_id, email, role, access_scope)
    values (new.project_id, new.accepted_by, new.email, 'researcher', 'gas_mixer')
    on conflict (project_id, user_id) do update
      set email = excluded.email, role = excluded.role, access_scope = excluded.access_scope, updated_at = now();
    insert into public.gas_mixer_researcher_access (user_id, can_control)
    values (new.accepted_by, true)
    on conflict (user_id) do update set can_control = true, enabled = true, revoked_at = null;
    return new;
  end if;

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
     or not public.has_gas_mixer_native_access(
       requested_project_id,
       requested_device_id,
       'remote_view'
     ) then
    raise exception 'Gas mixer access is required'
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
    'remote_control_allowed', public.has_gas_mixer_native_access(
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

create or replace function public.create_gas_mixer_invite(invitee_email text)
returns table(invite_id uuid, email text, invite_url text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare invitation record;
begin
  select * into invitation from public.create_project_invite(invitee_email,
    '44444444-4444-4444-8444-444444444441'::uuid, 'member', now() + interval '14 days');
  update public.project_invites set access_scope = 'gas_mixer' where id = invitation.invite_id;
  return query select invitation.invite_id, invitation.email, invitation.invite_url, invitation.expires_at;
end;
$$;
revoke all on function public.create_gas_mixer_invite(text) from public, anon, authenticated;
grant execute on function public.create_gas_mixer_invite(text) to service_role;

create or replace function public.has_portal_access(check_project_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.portal_access pa
    where pa.project_id = check_project_id and pa.user_id = auth.uid()
      and pa.access_scope = 'project');
$$;

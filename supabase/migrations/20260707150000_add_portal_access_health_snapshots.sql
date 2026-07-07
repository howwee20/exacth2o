create extension if not exists pgcrypto with schema extensions;

create table if not exists public.portal_access (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null check (email = lower(trim(email))),
  role text not null check (role in ('admin', 'researcher')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create index if not exists portal_access_project_role_idx
  on public.portal_access (project_id, role);

alter table public.portal_access enable row level security;

revoke all on table public.portal_access from anon;
revoke all on table public.portal_access from authenticated;
grant select on table public.portal_access to authenticated;
grant select, insert, update, delete on table public.portal_access to service_role;

create or replace function public.portal_role_for_email(account_email text)
returns text
language sql
immutable
as $$
  select case lower(trim(account_email))
    when 'howeeva1@msu.edu' then 'admin'
    when 'howeej2255@gmail.com' then 'admin'
    when 'basyalbi@msu.edu' then 'admin'
    when 'statamat@msu.edu' then 'researcher'
    else null
  end;
$$;

create or replace function public.is_portal_admin(check_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.portal_access pa
    where pa.project_id = check_project_id
      and pa.user_id = auth.uid()
      and pa.role = 'admin'
  );
$$;

revoke all on function public.is_portal_admin(uuid) from public, anon;
grant execute on function public.is_portal_admin(uuid) to authenticated, service_role;

drop policy if exists "Users can read their portal access" on public.portal_access;
create policy "Users can read their portal access"
  on public.portal_access
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_portal_admin(project_id)
  );

create table if not exists public.device_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  device_id text not null,
  device_name text not null default 'plain-feather',
  source text not null default 'owner-health',
  captured_at timestamptz not null default now(),
  owner_checked_at timestamptz,
  status_endpoint_ok boolean,
  history_endpoint_ok boolean,
  status_http_status integer,
  status_elapsed_ms integer,
  history_samples integer,
  overall_status text,
  api_status text,
  pi_online boolean,
  public_url_reachable boolean,
  ethernet_link boolean,
  ethernet_ip text,
  gateway_ping_ms numeric,
  undervoltage boolean,
  cpu_temp_c numeric,
  uptime_seconds numeric,
  sensors_expected integer,
  sensors_current integer,
  sensors_stale integer,
  sensors_missing integer,
  missing_sensors jsonb not null default '[]'::jsonb,
  stale_sensors jsonb not null default '[]'::jsonb,
  last_sensor_reading_at timestamptz,
  watering_last_event text,
  watering_last_event_at timestamptz,
  watering_events_last_24h integer,
  scheduler_jobs_loaded integer,
  active_alerts jsonb not null default '[]'::jsonb,
  known_issues jsonb not null default '[]'::jsonb,
  raw_status jsonb not null default '{}'::jsonb,
  raw_history jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists device_health_snapshots_project_device_captured_idx
  on public.device_health_snapshots (project_id, device_id, captured_at desc);

alter table public.device_health_snapshots enable row level security;

revoke all on table public.device_health_snapshots from anon;
revoke all on table public.device_health_snapshots from authenticated;
grant select on table public.device_health_snapshots to authenticated;
grant select, insert, update, delete on table public.device_health_snapshots to service_role;

drop policy if exists "Portal admins can read device health snapshots"
  on public.device_health_snapshots;
create policy "Portal admins can read device health snapshots"
  on public.device_health_snapshots
  for select
  to authenticated
  using (public.is_portal_admin(project_id));

with named_users as (
  select
    id,
    lower(email) as email,
    public.portal_role_for_email(email) as portal_role
  from auth.users
  where lower(email) in (
    'howeeva1@msu.edu',
    'howeej2255@gmail.com',
    'statamat@msu.edu',
    'basyalbi@msu.edu'
  )
)
insert into public.portal_access (project_id, user_id, email, role)
select
  '22222222-2222-4222-8222-222222222222'::uuid,
  id,
  email,
  portal_role
from named_users
where portal_role is not null
on conflict (project_id, user_id) do update
set email = excluded.email,
    role = excluded.role,
    updated_at = now();

create or replace function public.apply_project_invite_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  portal_role text := public.portal_role_for_email(new.email);
begin
  if new.accepted_at is null or new.accepted_by is null then
    return new;
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
  values (
    new.project_id,
    new.accepted_by,
    new.role
  )
  on conflict (project_id, user_id) do update
  set role = excluded.role;

  if portal_role is not null then
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
  end if;

  return new;
end;
$$;

drop policy if exists "Project members can read control commands"
  on public.project_control_commands;
drop policy if exists "Project members can read control audit"
  on public.project_control_audit;

drop policy if exists "Portal admins can read control commands"
  on public.project_control_commands;
create policy "Portal admins can read control commands"
  on public.project_control_commands
  for select
  to authenticated
  using (public.is_portal_admin(project_id));

drop policy if exists "Portal admins can read control audit"
  on public.project_control_audit;
create policy "Portal admins can read control audit"
  on public.project_control_audit
  for select
  to authenticated
  using (public.is_portal_admin(project_id));

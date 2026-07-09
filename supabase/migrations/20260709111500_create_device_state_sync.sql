create or replace function public.has_portal_access(check_project_id uuid)
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
  );
$$;

revoke all on function public.has_portal_access(uuid) from public, anon;
grant execute on function public.has_portal_access(uuid) to authenticated, service_role;

create table if not exists public.device_runtime_state (
  project_id uuid not null,
  device_id text not null,
  device_name text not null default 'plain-feather',
  source text not null default 'owner-health',
  controller_state text not null default 'UNKNOWN',
  controller_state_raw text,
  controller_state_updated_at timestamptz,
  state_observed_at timestamptz not null default now(),
  state_fresh_until timestamptz,
  owner_checked_at timestamptz,
  overall_status text,
  api_status text,
  pi_online boolean,
  public_url_reachable boolean,
  watering_enabled boolean,
  watering_disabled jsonb not null default '[]'::jsonb,
  watering_last_event text,
  watering_last_event_at timestamptz,
  watering_events_last_24h integer,
  scheduler_jobs_loaded integer,
  sensors_expected integer,
  sensors_current integer,
  sensors_stale integer,
  sensors_missing integer,
  last_sensor_reading_at timestamptz,
  config_hash text,
  raw_status jsonb not null default '{}'::jsonb,
  raw_health jsonb not null default '{}'::jsonb,
  raw_system jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id)
);

create index if not exists device_runtime_state_updated_idx
  on public.device_runtime_state (project_id, updated_at desc);

alter table public.device_runtime_state enable row level security;
alter table public.device_runtime_state replica identity full;

revoke all on table public.device_runtime_state from anon;
revoke all on table public.device_runtime_state from authenticated;
grant select on table public.device_runtime_state to authenticated;
grant select, insert, update, delete on table public.device_runtime_state to service_role;

drop policy if exists "Portal members can read device runtime state"
  on public.device_runtime_state;
create policy "Portal members can read device runtime state"
  on public.device_runtime_state
  for select
  to authenticated
  using (public.has_portal_access(project_id));

create table if not exists public.device_config_state (
  project_id uuid not null,
  device_id text not null,
  device_name text not null default 'plain-feather',
  source text not null default 'owner-health',
  observed_at timestamptz not null default now(),
  pairings jsonb not null default '[]'::jsonb,
  calibrations jsonb not null default '[]'::jsonb,
  board_config jsonb not null default '[]'::jsonb,
  sensors jsonb not null default '[]'::jsonb,
  valves jsonb not null default '[]'::jsonb,
  groups jsonb not null default '[]'::jsonb,
  pairing_count integer not null default 0,
  calibration_count integer not null default 0,
  board_count integer not null default 0,
  sensor_count integer not null default 0,
  valve_count integer not null default 0,
  group_count integer not null default 0,
  config_hash text,
  endpoint_status jsonb not null default '{}'::jsonb,
  raw_config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id)
);

create index if not exists device_config_state_updated_idx
  on public.device_config_state (project_id, updated_at desc);

alter table public.device_config_state enable row level security;
alter table public.device_config_state replica identity full;

revoke all on table public.device_config_state from anon;
revoke all on table public.device_config_state from authenticated;
grant select on table public.device_config_state to authenticated;
grant select, insert, update, delete on table public.device_config_state to service_role;

drop policy if exists "Portal members can read device config state"
  on public.device_config_state;
create policy "Portal members can read device config state"
  on public.device_config_state
  for select
  to authenticated
  using (public.has_portal_access(project_id));

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'device_runtime_state'
  ) then
    alter publication supabase_realtime add table public.device_runtime_state;
  end if;

  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'device_config_state'
  ) then
    alter publication supabase_realtime add table public.device_config_state;
  end if;
end $$;

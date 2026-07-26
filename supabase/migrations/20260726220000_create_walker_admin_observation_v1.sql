-- Walker Pi 5 historical observation portal.
--
-- This migration creates a separate, system-admin-only read model for the
-- verified Walker archive. It deliberately creates no controller token,
-- command executor, activation plan, pairing, valve, target, calibration, or
-- browser-to-device path.

do $$
declare
  walker_organization_id constant uuid :=
    '33333333-3333-4333-8333-333333333330'::uuid;
  walker_project_id constant uuid :=
    '33333333-3333-4333-8333-333333333331'::uuid;
  matt_project_id constant uuid :=
    '22222222-2222-4222-8222-222222222222'::uuid;
  selected_organization_id uuid;
begin
  select organization_id
  into selected_organization_id
  from public.projects
  where id = matt_project_id;

  if selected_organization_id is null then
    insert into public.organizations (id, slug, name)
    values (
      walker_organization_id,
      'walker-observation',
      'Walker Observation'
    )
    on conflict (id) do nothing;
    selected_organization_id := walker_organization_id;
  end if;

  insert into public.projects (id, organization_id, slug, name)
  values (
    walker_project_id,
    selected_organization_id,
    'walker-pi5-observation',
    'Walker Pi 5 Observation'
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
  '33333333-3333-4333-8333-333333333331'::uuid,
  '2026-07-26.walker-observation-v1',
  jsonb_build_object(
    'system_admin_only', true,
    'historical_only', true,
    'expected_sensor_count', 100,
    'evidenced_sensor_count', 96
  ),
  jsonb_build_object(
    'mode', 'observation_only',
    'portal_control_available', false,
    'controller_write_path', 'prohibited'
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
  '33333333-3333-4333-8333-333333333332'::uuid,
  project.organization_id,
  project.id,
  'walker-pi5',
  'Walker Pi 5',
  'America/Detroit',
  jsonb_build_object(
    'source', 'verified_historical_archive',
    'live_ingestion', false
  )
from public.projects project
where project.id = '33333333-3333-4333-8333-333333333331'::uuid
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
  'balena:a1c4ace2b367fbee8521f1aff6a6329b',
  project.organization_id,
  project.id,
  'a1c4ace2b367fbee8521f1aff6a6329b',
  'Binod-lab-pi5',
  'stale',
  '2026-07-15T17:53:00Z'::timestamptz
from public.projects project
where project.id = '33333333-3333-4333-8333-333333333331'::uuid
on conflict (id) do nothing;

create table if not exists public.system_admin_installation_access (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  portal_project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  capability text not null default 'observe'
    check (capability in ('observe', 'export')),
  enabled boolean not null default true,
  revoked_at timestamptz,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  primary key (project_id, device_id, user_id, capability)
);

comment on table public.system_admin_installation_access is
  'Explicit installation capability allowlist. A generic portal admin role is insufficient.';

create or replace function public.has_system_admin_installation_access(
  check_project_id uuid,
  check_device_id text,
  check_capability text default 'observe'
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.system_admin_installation_access access
    join public.portal_access portal
      on portal.project_id = access.portal_project_id
     and portal.user_id = access.user_id
     and portal.role = 'admin'
    where access.project_id = check_project_id
      and access.device_id = check_device_id
      and access.user_id = (select auth.uid())
      and access.capability = check_capability
      and access.enabled
      and access.revoked_at is null
  );
$$;

revoke all on function public.has_system_admin_installation_access(
  uuid, text, text
) from public, anon;
grant execute on function public.has_system_admin_installation_access(
  uuid, text, text
) to authenticated, service_role;

create table if not exists public.walker_observation_workspaces (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 120),
  workspace_type text not null
    check (workspace_type in ('completed_archive', 'planned_validation')),
  lifecycle_state text not null
    check (lifecycle_state in ('completed', 'planned')),
  observation_mode text not null default 'historical'
    check (observation_mode in ('historical', 'planned')),
  started_at timestamptz,
  ended_at timestamptz,
  watering_state text not null default 'off'
    check (watering_state = 'off'),
  immutable boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (project_id, device_id, slug)
);

create table if not exists public.walker_observation_imports (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  archive_name text not null,
  archive_sha256 text,
  readings_file_sha256 text not null check (char_length(readings_file_sha256) = 64),
  expected_reading_count integer not null check (expected_reading_count > 0),
  expected_sensor_count integer not null check (expected_sensor_count > 0),
  expected_first_at timestamptz not null,
  expected_last_at timestamptz not null,
  status text not null default 'planned'
    check (status in ('planned', 'importing', 'verified', 'failed')),
  imported_reading_count integer not null default 0,
  imported_sensor_count integer not null default 0,
  verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create table if not exists public.walker_observation_sensor_metadata (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  source_sensor_id integer not null,
  sensor_key text not null check (char_length(sensor_key) between 3 and 160),
  display_label text not null check (char_length(display_label) between 1 and 120),
  source_pairing_name text not null check (char_length(source_pairing_name) between 1 and 120),
  position_number integer check (position_number between 1 and 1000),
  board_serial_id text not null,
  sensor_address text not null,
  historical_group text,
  first_reading_at timestamptz,
  last_reading_at timestamptz,
  latest_calibrated_value double precision,
  reading_count integer not null default 0 check (reading_count >= 0),
  quality_flags jsonb not null default '{}'::jsonb
    check (jsonb_typeof(quality_flags) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, device_id, source_sensor_id),
  unique (device_id, sensor_key)
);

create table if not exists public.walker_observation_trace_buckets (
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  source_sensor_id integer not null,
  bucket_start timestamptz not null,
  minimum_value double precision,
  maximum_value double precision,
  average_value double precision,
  sample_count integer not null check (sample_count > 0),
  primary key (project_id, device_id, source_sensor_id, bucket_start),
  foreign key (project_id, device_id, source_sensor_id)
    references public.walker_observation_sensor_metadata(
      project_id, device_id, source_sensor_id
    )
    on delete cascade
);

create index if not exists walker_observation_trace_buckets_time_idx
  on public.walker_observation_trace_buckets (
    project_id, device_id, bucket_start, source_sensor_id
  );

insert into public.walker_observation_workspaces (
  id,
  project_id,
  device_id,
  slug,
  name,
  workspace_type,
  lifecycle_state,
  observation_mode,
  started_at,
  ended_at,
  watering_state,
  immutable,
  metadata
) values
(
  '33333333-3333-4333-8333-333333333340'::uuid,
  '33333333-3333-4333-8333-333333333331'::uuid,
  'balena:a1c4ace2b367fbee8521f1aff6a6329b',
  'drought-for-harvest-archive',
  'Drought-for-Harvest Experiment',
  'completed_archive',
  'completed',
  'historical',
  '2026-03-10T04:00:00Z'::timestamptz,
  '2026-07-15T04:00:00Z'::timestamptz,
  'off',
  true,
  jsonb_build_object(
    'date_scope', 'verified_archive_window',
    'controller_state_at_last_verification', 'STOPPED'
  )
),
(
  '33333333-3333-4333-8333-333333333341'::uuid,
  '33333333-3333-4333-8333-333333333331'::uuid,
  'balena:a1c4ace2b367fbee8521f1aff6a6329b',
  'walker-algorithm-validation-v1',
  'Algorithm Validation Workspace',
  'planned_validation',
  'planned',
  'planned',
  null,
  null,
  'off',
  false,
  jsonb_build_object(
    'historical_only', true,
    'controller_binding', 'none'
  )
)
on conflict (id) do nothing;

insert into public.walker_observation_imports (
  id,
  project_id,
  device_id,
  archive_name,
  readings_file_sha256,
  expected_reading_count,
  expected_sensor_count,
  expected_first_at,
  expected_last_at,
  metadata
) values (
  '33333333-3333-4333-8333-333333333350'::uuid,
  '33333333-3333-4333-8333-333333333331'::uuid,
  'balena:a1c4ace2b367fbee8521f1aff6a6329b',
  'Walker_Pi5_Data_2026-03-10_to_2026-07-14',
  '6592a8ee109609455dd37f3b8ad32ac0e2b1bd25469e5db7ab0382e3e4f02a23',
  858720,
  96,
  '2026-03-10T04:01:53Z'::timestamptz,
  '2026-07-15T03:59:57Z'::timestamptz,
  jsonb_build_object(
    'source', 'verified_read_only_export',
    'expected_positions', 100,
    'missing_numeric_positions', jsonb_build_array(48, 50, 51, 100),
    'position_41_label', 'Q-41'
  )
)
on conflict (id) do nothing;

insert into public.system_admin_installation_access (
  project_id,
  device_id,
  portal_project_id,
  user_id,
  capability,
  metadata
)
select
  '33333333-3333-4333-8333-333333333331'::uuid,
  'balena:a1c4ace2b367fbee8521f1aff6a6329b',
  '22222222-2222-4222-8222-222222222222'::uuid,
  portal.user_id,
  capability.name,
  jsonb_build_object(
    'reason', 'Walker Gate A system-admin observation',
    'email', lower(portal.email)
  )
from public.portal_access portal
cross join (values ('observe'), ('export')) as capability(name)
where portal.project_id = '22222222-2222-4222-8222-222222222222'::uuid
  and portal.role = 'admin'
  and lower(portal.email) = 'howeeva1@msu.edu'
on conflict (project_id, device_id, user_id, capability) do nothing;

create or replace function public.walker_observation_block_membership()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.project_id = '33333333-3333-4333-8333-333333333331'::uuid then
    raise exception 'Walker observation access requires the explicit system-admin installation allowlist';
  end if;
  return new;
end;
$$;

drop trigger if exists block_walker_project_membership on public.project_members;
create trigger block_walker_project_membership
before insert or update on public.project_members
for each row execute function public.walker_observation_block_membership();

drop trigger if exists block_walker_portal_access on public.portal_access;
create trigger block_walker_portal_access
before insert or update on public.portal_access
for each row execute function public.walker_observation_block_membership();

create or replace function public.walker_observation_block_control_path()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  row_data jsonb := to_jsonb(new);
begin
  if coalesce(row_data ->> 'project_id', '') =
       '33333333-3333-4333-8333-333333333331'
     or coalesce(row_data ->> 'device_id', '') =
       'balena:a1c4ace2b367fbee8521f1aff6a6329b' then
    raise exception 'Walker Gate A is observation-only; controller registration and commands are prohibited';
  end if;
  return new;
end;
$$;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'device_control_tokens',
    'device_secrets',
    'project_control_commands',
    'experiment_control_plans',
    'assistant_schedules'
  ]
  loop
    if to_regclass('public.' || target_table) is not null then
      execute format(
        'drop trigger if exists block_walker_control_path on public.%I',
        target_table
      );
      execute format(
        'create trigger block_walker_control_path before insert or update on public.%I for each row execute function public.walker_observation_block_control_path()',
        target_table
      );
    end if;
  end loop;
end;
$$;

create or replace function public.walker_observation_preserve_completed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.workspace_type = 'completed_archive' and old.immutable then
    raise exception 'Completed Walker observation history is immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_completed_walker_workspace
  on public.walker_observation_workspaces;
create trigger preserve_completed_walker_workspace
before update or delete on public.walker_observation_workspaces
for each row execute function public.walker_observation_preserve_completed();

create or replace function public.walker_observation_overview(
  requested_project_id uuid default
    '33333333-3333-4333-8333-333333333331'::uuid,
  requested_device_id text default
    'balena:a1c4ace2b367fbee8521f1aff6a6329b'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  if not public.has_system_admin_installation_access(
    requested_project_id,
    requested_device_id,
    'observe'
  ) then
    raise exception 'Walker system administrator observation access required'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'project_id', project.id,
    'device_id', device.id,
    'device_name', device.name,
    'source', 'verified_historical_archive',
    'freshness', 'stale',
    'live_ingestion', false,
    'latest_verified_reading_at', coalesce(
      max(metadata.last_reading_at),
      '2026-07-15T03:59:57Z'::timestamptz
    ),
    'historical_controller_state', 'STOPPED',
    'controller_state_observed_at', '2026-07-15T17:57:48Z',
    'portal_control_available', false,
    'physical_water_capable', true,
    'expected_sensor_count', 100,
    'evidenced_sensor_count', count(metadata.source_sensor_id),
    'inventory_discrepancy', jsonb_build_object(
      'missing_numeric_positions', jsonb_build_array(48, 50, 51, 100),
      'position_41_label', 'Q-41',
      'resolved', false
    ),
    'workspaces', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', workspace.id,
          'slug', workspace.slug,
          'name', workspace.name,
          'workspace_type', workspace.workspace_type,
          'lifecycle_state', workspace.lifecycle_state,
          'observation_mode', workspace.observation_mode,
          'started_at', workspace.started_at,
          'ended_at', workspace.ended_at,
          'watering_state', workspace.watering_state,
          'immutable', workspace.immutable
        )
        order by
          case workspace.workspace_type when 'completed_archive' then 0 else 1 end,
          workspace.name
      )
      from public.walker_observation_workspaces workspace
      where workspace.project_id = requested_project_id
        and workspace.device_id = requested_device_id
    ), '[]'::jsonb),
    'archive', (
      select jsonb_build_object(
        'name', archive.archive_name,
        'status', archive.status,
        'expected_reading_count', archive.expected_reading_count,
        'imported_reading_count', archive.imported_reading_count,
        'expected_sensor_count', archive.expected_sensor_count,
        'imported_sensor_count', archive.imported_sensor_count,
        'expected_first_at', archive.expected_first_at,
        'expected_last_at', archive.expected_last_at,
        'verified_at', archive.verified_at
      )
      from public.walker_observation_imports archive
      where archive.project_id = requested_project_id
        and archive.device_id = requested_device_id
      order by archive.created_at desc
      limit 1
    ),
    'sensors', coalesce(jsonb_agg(
      jsonb_build_object(
        'source_sensor_id', metadata.source_sensor_id,
        'sensor_key', metadata.sensor_key,
        'display_label', metadata.display_label,
        'source_pairing_name', metadata.source_pairing_name,
        'position_number', metadata.position_number,
        'board_serial_id', metadata.board_serial_id,
        'sensor_address', metadata.sensor_address,
        'historical_group', metadata.historical_group,
        'first_reading_at', metadata.first_reading_at,
        'last_reading_at', metadata.last_reading_at,
        'latest_calibrated_value', metadata.latest_calibrated_value,
        'reading_count', metadata.reading_count,
        'quality_flags', metadata.quality_flags
      )
      order by metadata.position_number nulls last, metadata.source_pairing_name
    ) filter (where metadata.source_sensor_id is not null), '[]'::jsonb)
  )
  into result
  from public.projects project
  join public.devices device
    on device.project_id = project.id
   and device.id = requested_device_id
  left join public.walker_observation_sensor_metadata metadata
    on metadata.project_id = project.id
   and metadata.device_id = device.id
  where project.id = requested_project_id
  group by project.id, device.id, device.name;

  if result is null then
    raise exception 'Walker observation installation not found';
  end if;
  return result;
end;
$$;

create or replace function public.walker_observation_trace_page(
  requested_project_id uuid default
    '33333333-3333-4333-8333-333333333331'::uuid,
  requested_device_id text default
    'balena:a1c4ace2b367fbee8521f1aff6a6329b',
  requested_sensor_ids integer[] default null,
  requested_start timestamptz default null,
  requested_end timestamptz default null,
  requested_point_budget integer default 240
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  range_start timestamptz;
  range_end timestamptz;
  sensor_ids integer[];
  bounded_budget integer;
  bucket_seconds bigint;
  result jsonb;
begin
  if not public.has_system_admin_installation_access(
    requested_project_id,
    requested_device_id,
    'observe'
  ) then
    raise exception 'Walker system administrator observation access required'
      using errcode = '42501';
  end if;

  if requested_sensor_ids is null then
    select array_agg(
      source_sensor_id order by position_number nulls last, source_sensor_id
    )
    into sensor_ids
    from public.walker_observation_sensor_metadata
    where project_id = requested_project_id
      and device_id = requested_device_id;
  else
    sensor_ids := requested_sensor_ids;
  end if;

  if coalesce(array_length(sensor_ids, 1), 0) = 0
     or array_length(sensor_ids, 1) > 96 then
    raise exception 'Select between 1 and 96 Walker sensors';
  end if;

  if exists (
    select 1
    from unnest(sensor_ids) selected_id
    where not exists (
      select 1
      from public.walker_observation_sensor_metadata metadata
      where metadata.project_id = requested_project_id
        and metadata.device_id = requested_device_id
        and metadata.source_sensor_id = selected_id
    )
  ) then
    raise exception 'Requested Walker sensor is not in the verified inventory';
  end if;

  select
    coalesce(requested_start, min(bucket_start)),
    coalesce(requested_end, max(bucket_start) + interval '1 hour')
  into range_start, range_end
  from public.walker_observation_trace_buckets
  where project_id = requested_project_id
    and device_id = requested_device_id
    and source_sensor_id = any(sensor_ids);

  if range_start is null or range_end is null then
    return jsonb_build_object(
      'range_start', null,
      'range_end', null,
      'point_budget', greatest(50, least(coalesce(requested_point_budget, 240), 600)),
      'series', '[]'::jsonb
    );
  end if;
  if range_end <= range_start then
    raise exception 'Walker trace end must be later than start';
  end if;
  if range_end - range_start > interval '370 days' then
    raise exception 'Walker trace window exceeds 370 days';
  end if;

  bounded_budget := greatest(50, least(coalesce(requested_point_budget, 240), 600));
  bucket_seconds := greatest(
    3600,
    ceil(
      extract(epoch from (range_end - range_start)) /
      bounded_budget::numeric /
      3600
    )::bigint * 3600
  );

  with bucketed as (
    select
      bucket.source_sensor_id,
      to_timestamp(
        floor(extract(epoch from bucket.bucket_start) / bucket_seconds) *
        bucket_seconds
      ) as point_at,
      min(bucket.minimum_value) as minimum_value,
      max(bucket.maximum_value) as maximum_value,
      sum(bucket.average_value * bucket.sample_count) /
        nullif(sum(bucket.sample_count), 0) as average_value,
      sum(bucket.sample_count)::integer as sample_count
    from public.walker_observation_trace_buckets bucket
    where bucket.project_id = requested_project_id
      and bucket.device_id = requested_device_id
      and bucket.source_sensor_id = any(sensor_ids)
      and bucket.bucket_start >= range_start
      and bucket.bucket_start < range_end
    group by bucket.source_sensor_id, point_at
  ),
  series_rows as (
    select
      metadata.source_sensor_id,
      metadata.display_label,
      metadata.source_pairing_name,
      metadata.board_serial_id,
      metadata.historical_group,
      coalesce(jsonb_agg(
        jsonb_build_object(
          'at', bucketed.point_at,
          'minimum', bucketed.minimum_value,
          'maximum', bucketed.maximum_value,
          'average', bucketed.average_value,
          'sample_count', bucketed.sample_count
        )
        order by bucketed.point_at
      ) filter (where bucketed.point_at is not null), '[]'::jsonb) as points
    from public.walker_observation_sensor_metadata metadata
    left join bucketed
      on bucketed.source_sensor_id = metadata.source_sensor_id
    where metadata.project_id = requested_project_id
      and metadata.device_id = requested_device_id
      and metadata.source_sensor_id = any(sensor_ids)
    group by
      metadata.source_sensor_id,
      metadata.display_label,
      metadata.source_pairing_name,
      metadata.board_serial_id,
      metadata.historical_group,
      metadata.position_number
    order by metadata.position_number nulls last, metadata.source_sensor_id
  )
  select jsonb_build_object(
    'range_start', range_start,
    'range_end', range_end,
    'point_budget', bounded_budget,
    'bucket_seconds', bucket_seconds,
    'series', coalesce(jsonb_agg(
      jsonb_build_object(
        'source_sensor_id', series_rows.source_sensor_id,
        'display_label', series_rows.display_label,
        'source_pairing_name', series_rows.source_pairing_name,
        'board_serial_id', series_rows.board_serial_id,
        'historical_group', series_rows.historical_group,
        'points', series_rows.points
      )
      order by series_rows.source_sensor_id
    ), '[]'::jsonb)
  )
  into result
  from series_rows;

  return result;
end;
$$;

create or replace function public.walker_observation_import_readings(
  reading_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  walker_project_id constant uuid :=
    '33333333-3333-4333-8333-333333333331'::uuid;
  walker_device_id constant text :=
    'balena:a1c4ace2b367fbee8521f1aff6a6329b';
  walker_organization_id uuid;
  invalid_count integer;
  inserted_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may import Walker historical readings';
  end if;
  if jsonb_typeof(reading_rows) <> 'array'
     or jsonb_array_length(reading_rows) < 1
     or jsonb_array_length(reading_rows) > 1000 then
    raise exception 'reading_rows must contain between 1 and 1000 records';
  end if;

  select organization_id
  into walker_organization_id
  from public.projects
  where id = walker_project_id;

  if walker_organization_id is null then
    raise exception 'Walker observation project is missing';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('exacth2o:walker-historical-import', 0)
  );

  select count(*)::integer
  into invalid_count
  from jsonb_to_recordset(reading_rows) as row_data(
    source_reading_id bigint,
    source_sensor_id integer,
    sensor_key text,
    pairing_name text,
    raw_value double precision,
    calibrated_value double precision,
    temperature double precision,
    electrical_conductivity double precision,
    device_recorded_at timestamptz
  )
  left join public.walker_observation_sensor_metadata metadata
    on metadata.project_id = walker_project_id
   and metadata.device_id = walker_device_id
   and metadata.source_sensor_id = row_data.source_sensor_id
   and metadata.sensor_key = trim(row_data.sensor_key)
   and metadata.source_pairing_name = trim(row_data.pairing_name)
  where row_data.source_reading_id is null
     or row_data.source_sensor_id is null
     or row_data.raw_value is null
     or row_data.calibrated_value is null
     or row_data.device_recorded_at is null
     or metadata.source_sensor_id is null;

  if invalid_count > 0 then
    raise exception
      'Walker reading batch contains % invalid or unmapped records',
      invalid_count;
  end if;

  with candidate_rows as (
    select
      row_data.source_reading_id,
      row_data.source_sensor_id,
      trim(row_data.sensor_key) as sensor_key,
      trim(row_data.pairing_name) as pairing_name,
      row_data.raw_value,
      row_data.calibrated_value,
      row_data.temperature,
      row_data.electrical_conductivity,
      row_data.device_recorded_at
    from jsonb_to_recordset(reading_rows) as row_data(
      source_reading_id bigint,
      source_sensor_id integer,
      sensor_key text,
      pairing_name text,
      raw_value double precision,
      calibrated_value double precision,
      temperature double precision,
      electrical_conductivity double precision,
      device_recorded_at timestamptz
    )
  ),
  validated_rows as (
    select candidate.*
    from candidate_rows candidate
    join public.walker_observation_sensor_metadata metadata
      on metadata.project_id = walker_project_id
     and metadata.device_id = walker_device_id
     and metadata.source_sensor_id = candidate.source_sensor_id
     and metadata.sensor_key = candidate.sensor_key
     and metadata.source_pairing_name = candidate.pairing_name
    where candidate.source_reading_id is not null
      and candidate.source_sensor_id is not null
      and candidate.raw_value is not null
      and candidate.calibrated_value is not null
      and candidate.device_recorded_at is not null
  ),
  inserted as (
    insert into public.sensor_readings (
      event_id,
      organization_id,
      project_id,
      device_id,
      source_sensor_id,
      sensor_key,
      pairing_name,
      device_recorded_at,
      server_received_at,
      raw_value,
      calibrated_value,
      temperature,
      electrical_conductivity,
      unit,
      quality_flags
    )
    select
      'walker:a1c4ace2b367fbee8521f1aff6a6329b:reading:' ||
        candidate.source_reading_id,
      walker_organization_id,
      walker_project_id,
      walker_device_id,
      candidate.source_sensor_id,
      candidate.sensor_key,
      candidate.pairing_name,
      candidate.device_recorded_at,
      now(),
      candidate.raw_value,
      candidate.calibrated_value,
      candidate.temperature,
      candidate.electrical_conductivity,
      'vwc_pct',
      jsonb_build_object(
        'source', 'verified_walker_historical_archive',
        'historical', true
      )
    from validated_rows candidate
    on conflict (event_id) do nothing
    returning 1
  )
  select count(*)::integer
  into inserted_count
  from inserted;

  return inserted_count;
end;
$$;

create or replace function public.walker_observation_finalize_import()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  walker_project_id constant uuid :=
    '33333333-3333-4333-8333-333333333331'::uuid;
  walker_device_id constant text :=
    'balena:a1c4ace2b367fbee8521f1aff6a6329b';
  actual_reading_count integer;
  actual_sensor_count integer;
  actual_first_at timestamptz;
  actual_last_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may finalize a Walker historical import';
  end if;

  select
    count(*)::integer,
    count(distinct source_sensor_id)::integer,
    min(device_recorded_at),
    max(device_recorded_at)
  into
    actual_reading_count,
    actual_sensor_count,
    actual_first_at,
    actual_last_at
  from public.sensor_readings
  where project_id = walker_project_id
    and device_id = walker_device_id
    and event_id like
      'walker:a1c4ace2b367fbee8521f1aff6a6329b:reading:%';

  if actual_reading_count <> 858720
     or actual_sensor_count <> 96
     or actual_first_at <> '2026-03-10T04:01:53Z'::timestamptz
     or actual_last_at <> '2026-07-15T03:59:57Z'::timestamptz then
    raise exception
      'Walker archive reconciliation failed: readings %, sensors %, first %, last %',
      actual_reading_count,
      actual_sensor_count,
      actual_first_at,
      actual_last_at;
  end if;

  if (
    select count(*)
    from public.walker_observation_sensor_metadata
    where project_id = walker_project_id
      and device_id = walker_device_id
  ) <> 96 then
    raise exception 'Walker sensor catalog must contain exactly 96 evidenced records';
  end if;

  update public.walker_observation_sensor_metadata metadata
  set
    first_reading_at = summary.first_reading_at,
    last_reading_at = summary.last_reading_at,
    latest_calibrated_value = summary.latest_calibrated_value,
    reading_count = summary.reading_count,
    updated_at = now()
  from (
    select distinct on (reading.source_sensor_id)
      reading.source_sensor_id,
      min(reading.device_recorded_at) over (
        partition by reading.source_sensor_id
      ) as first_reading_at,
      max(reading.device_recorded_at) over (
        partition by reading.source_sensor_id
      ) as last_reading_at,
      first_value(reading.calibrated_value) over (
        partition by reading.source_sensor_id
        order by reading.device_recorded_at desc
      ) as latest_calibrated_value,
      count(*) over (
        partition by reading.source_sensor_id
      )::integer as reading_count
    from public.sensor_readings reading
    where reading.project_id = walker_project_id
      and reading.device_id = walker_device_id
    order by reading.source_sensor_id, reading.device_recorded_at desc
  ) summary
  where metadata.project_id = walker_project_id
    and metadata.device_id = walker_device_id
    and metadata.source_sensor_id = summary.source_sensor_id;

  delete from public.walker_observation_trace_buckets
  where project_id = walker_project_id
    and device_id = walker_device_id;

  insert into public.walker_observation_trace_buckets (
    project_id,
    device_id,
    source_sensor_id,
    bucket_start,
    minimum_value,
    maximum_value,
    average_value,
    sample_count
  )
  select
    walker_project_id,
    walker_device_id,
    reading.source_sensor_id,
    date_trunc('hour', reading.device_recorded_at),
    min(reading.calibrated_value),
    max(reading.calibrated_value),
    avg(reading.calibrated_value),
    count(*)::integer
  from public.sensor_readings reading
  where reading.project_id = walker_project_id
    and reading.device_id = walker_device_id
  group by reading.source_sensor_id, date_trunc('hour', reading.device_recorded_at);

  update public.walker_observation_imports
  set
    status = 'verified',
    imported_reading_count = actual_reading_count,
    imported_sensor_count = actual_sensor_count,
    verified_at = now()
  where id = '33333333-3333-4333-8333-333333333350'::uuid;

  update public.devices
  set status = 'stale',
      last_seen_at = actual_last_at
  where id = walker_device_id
    and project_id = walker_project_id;

  return jsonb_build_object(
    'verified', true,
    'reading_count', actual_reading_count,
    'sensor_count', actual_sensor_count,
    'first_at', actual_first_at,
    'last_at', actual_last_at,
    'bucket_count', (
      select count(*)
      from public.walker_observation_trace_buckets
      where project_id = walker_project_id
        and device_id = walker_device_id
    )
  );
end;
$$;

alter table public.system_admin_installation_access enable row level security;
alter table public.walker_observation_workspaces enable row level security;
alter table public.walker_observation_imports enable row level security;
alter table public.walker_observation_sensor_metadata enable row level security;
alter table public.walker_observation_trace_buckets enable row level security;

create policy "users read own installation capabilities"
  on public.system_admin_installation_access for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_system_admin_installation_access(
      project_id, device_id, capability
    )
  );
create policy "allowed system admins read Walker workspaces"
  on public.walker_observation_workspaces for select to authenticated
  using (
    public.has_system_admin_installation_access(
      project_id, device_id, 'observe'
    )
  );
create policy "allowed system admins read Walker imports"
  on public.walker_observation_imports for select to authenticated
  using (
    public.has_system_admin_installation_access(
      project_id, device_id, 'observe'
    )
  );
create policy "allowed system admins read Walker sensor metadata"
  on public.walker_observation_sensor_metadata for select to authenticated
  using (
    public.has_system_admin_installation_access(
      project_id, device_id, 'observe'
    )
  );
create policy "allowed system admins read Walker trace buckets"
  on public.walker_observation_trace_buckets for select to authenticated
  using (
    public.has_system_admin_installation_access(
      project_id, device_id, 'observe'
    )
  );

create policy "allowed system admins read Walker project"
  on public.projects for select to authenticated
  using (
    id = '33333333-3333-4333-8333-333333333331'::uuid
    and public.has_system_admin_installation_access(
      id,
      'balena:a1c4ace2b367fbee8521f1aff6a6329b',
      'observe'
    )
  );
create policy "allowed system admins read Walker device"
  on public.devices for select to authenticated
  using (
    project_id = '33333333-3333-4333-8333-333333333331'::uuid
    and public.has_system_admin_installation_access(
      project_id, id, 'observe'
    )
  );
create policy "allowed system admins read Walker sensors"
  on public.sensors for select to authenticated
  using (
    project_id = '33333333-3333-4333-8333-333333333331'::uuid
    and public.has_system_admin_installation_access(
      project_id, device_id, 'observe'
    )
  );
create policy "allowed system admins read Walker historical readings"
  on public.sensor_readings for select to authenticated
  using (
    project_id = '33333333-3333-4333-8333-333333333331'::uuid
    and public.has_system_admin_installation_access(
      project_id, device_id, 'observe'
    )
  );
create policy "allowed system admins read Walker site"
  on public.research_sites for select to authenticated
  using (
    project_id = '33333333-3333-4333-8333-333333333331'::uuid
    and public.has_system_admin_installation_access(
      project_id,
      'balena:a1c4ace2b367fbee8521f1aff6a6329b',
      'observe'
    )
  );
create policy "allowed system admins read Walker platform config"
  on public.project_platform_config for select to authenticated
  using (
    project_id = '33333333-3333-4333-8333-333333333331'::uuid
    and public.has_system_admin_installation_access(
      project_id,
      'balena:a1c4ace2b367fbee8521f1aff6a6329b',
      'observe'
    )
  );

revoke all on public.system_admin_installation_access
  from public, anon, authenticated;
revoke all on public.walker_observation_workspaces
  from public, anon, authenticated;
revoke all on public.walker_observation_imports
  from public, anon, authenticated;
revoke all on public.walker_observation_sensor_metadata
  from public, anon, authenticated;
revoke all on public.walker_observation_trace_buckets
  from public, anon, authenticated;

grant select on public.system_admin_installation_access to authenticated;
grant select on public.walker_observation_workspaces to authenticated;
grant select on public.walker_observation_imports to authenticated;
grant select on public.walker_observation_sensor_metadata to authenticated;
grant select on public.walker_observation_trace_buckets to authenticated;

grant select, insert, update, delete
  on public.system_admin_installation_access to service_role;
grant select, insert, update, delete
  on public.walker_observation_workspaces to service_role;
grant select, insert, update, delete
  on public.walker_observation_imports to service_role;
grant select, insert, update, delete
  on public.walker_observation_sensor_metadata to service_role;
grant select, insert, update, delete
  on public.walker_observation_trace_buckets to service_role;

revoke all on function public.walker_observation_overview(uuid, text)
  from public, anon;
revoke all on function public.walker_observation_trace_page(
  uuid, text, integer[], timestamptz, timestamptz, integer
) from public, anon;
revoke all on function public.walker_observation_finalize_import()
  from public, anon, authenticated;
revoke all on function public.walker_observation_import_readings(jsonb)
  from public, anon, authenticated;
grant execute on function public.walker_observation_overview(uuid, text)
  to authenticated, service_role;
grant execute on function public.walker_observation_trace_page(
  uuid, text, integer[], timestamptz, timestamptz, integer
) to authenticated, service_role;
grant execute on function public.walker_observation_finalize_import()
  to service_role;
grant execute on function public.walker_observation_import_readings(jsonb)
  to service_role;

do $$
begin
  if exists (
    select 1
    from public.device_control_tokens
    where project_id = '33333333-3333-4333-8333-333333333331'::uuid
       or device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
  ) then
    raise exception 'Walker Gate A must not have a device control token';
  end if;
  if exists (
    select 1
    from public.project_control_commands
    where project_id = '33333333-3333-4333-8333-333333333331'::uuid
       or device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
  ) then
    raise exception 'Walker Gate A must not have a portal control command';
  end if;
end;
$$;

comment on table public.walker_observation_sensor_metadata is
  'Verified Walker historical sensor catalog. It contains no valve or control identity.';
comment on table public.walker_observation_trace_buckets is
  'Read-only hourly visualization aggregates derived from the immutable verified Walker archive.';
comment on function public.walker_observation_overview(uuid, text) is
  'System-admin-only historical Walker DTO. It returns no controller endpoint or control capability.';

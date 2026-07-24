-- ExactH2O sensing experiment builder.
--
-- This migration is additive. It records portal-only experiment definitions
-- and immutable revisions. It does not write controller commands, pairings,
-- targets, valves, groups, calibrations, Balena state, or watering state.

create table if not exists public.experiments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) <= 80),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 300),
  mode text not null check (mode in ('controlled', 'observation', 'calibration')),
  status text not null default 'published_sensing'
    check (status in ('published_sensing', 'active', 'completed', 'archived')),
  watering_state text not null default 'off'
    check (watering_state in ('off', 'controller_managed')),
  visible_to_roles text[] not null default array['admin', 'researcher']::text[]
    check (
      visible_to_roles <@ array['admin', 'researcher']::text[]
      and visible_to_roles @> array['admin']::text[]
    ),
  started_at timestamptz,
  ended_at timestamptz,
  current_revision_id uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, slug),
  unique (id, project_id)
);

create table if not exists public.experiment_revisions (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null,
  project_id uuid not null,
  version integer not null check (version > 0),
  source text not null check (source in ('legacy', 'manual', 'natural_language')),
  spec jsonb not null check (jsonb_typeof(spec) = 'object'),
  inventory_updated_at timestamptz,
  inventory_hash text,
  model_name text,
  prompt_fingerprint text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (experiment_id, project_id)
    references public.experiments(id, project_id)
    on delete cascade,
  unique (experiment_id, version),
  unique (id, experiment_id, project_id)
);

alter table public.experiments
  drop constraint if exists experiments_current_revision_fk;
alter table public.experiments
  add constraint experiments_current_revision_fk
  foreign key (current_revision_id, id, project_id)
  references public.experiment_revisions(id, experiment_id, project_id)
  deferrable initially deferred;

create table if not exists public.experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null,
  experiment_id uuid not null,
  project_id uuid not null,
  pairing_name text not null check (char_length(pairing_name) between 1 and 120),
  zone integer not null check (zone between 1 and 100),
  pot_number integer not null check (pot_number between 1 and 10000),
  crop text check (crop is null or char_length(crop) <= 80),
  treatment text check (treatment is null or char_length(treatment) <= 80),
  block text check (block is null or char_length(block) <= 80),
  substrate text check (substrate is null or char_length(substrate) <= 80),
  target_vwc_percent double precision
    check (target_vwc_percent is null or target_vwc_percent between 0 and 100),
  measurement_interval_minutes double precision
    check (measurement_interval_minutes is null or measurement_interval_minutes between 1 and 1440),
  notes text check (notes is null or char_length(notes) <= 300),
  sensor_key_snapshot text not null check (char_length(sensor_key_snapshot) between 1 and 160),
  valve_key_snapshot text not null check (char_length(valve_key_snapshot) between 1 and 160),
  calibration_name_snapshot text,
  source_target_vwc_percent double precision,
  source_valve_open_time_ms integer,
  source_measurement_interval_ms integer,
  created_at timestamptz not null default now(),
  foreign key (revision_id, experiment_id, project_id)
    references public.experiment_revisions(id, experiment_id, project_id)
    on delete cascade,
  unique (revision_id, pairing_name)
);

create table if not exists public.experiment_audit_events (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null,
  project_id uuid not null,
  revision_id uuid,
  event_type text not null check (event_type in ('legacy_imported', 'published_sensing', 'archived')),
  actor_id uuid references auth.users(id),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (experiment_id, project_id)
    references public.experiments(id, project_id)
    on delete cascade
);

create table if not exists public.experiment_builder_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('manual', 'natural_language')),
  status text not null check (status in ('started', 'completed', 'rejected', 'failed')),
  model_name text,
  prompt_fingerprint text,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists experiments_project_status_idx
  on public.experiments (project_id, status, updated_at desc);
create index if not exists experiment_revisions_experiment_version_idx
  on public.experiment_revisions (experiment_id, version desc);
create index if not exists experiment_assignments_experiment_pot_idx
  on public.experiment_assignments (experiment_id, zone, pot_number);
create index if not exists experiment_audit_project_created_idx
  on public.experiment_audit_events (project_id, created_at desc);
create index if not exists experiment_builder_requests_user_created_idx
  on public.experiment_builder_requests (project_id, user_id, created_at desc);

create or replace function public.current_portal_role(check_project_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select pa.role
  from public.portal_access pa
  where pa.project_id = check_project_id
    and pa.user_id = auth.uid()
  limit 1;
$$;

revoke all on function public.current_portal_role(uuid) from public, anon;
grant execute on function public.current_portal_role(uuid) to authenticated, service_role;

alter table public.experiments enable row level security;
alter table public.experiment_revisions enable row level security;
alter table public.experiment_assignments enable row level security;
alter table public.experiment_audit_events enable row level security;
alter table public.experiment_builder_requests enable row level security;

drop policy if exists "portal members read visible experiments" on public.experiments;
create policy "portal members read visible experiments"
  on public.experiments for select to authenticated
  using (
    public.has_portal_access(project_id)
    and (
      public.current_portal_role(project_id) = 'admin'
      or public.current_portal_role(project_id) = any(visible_to_roles)
    )
  );

drop policy if exists "portal members read experiment revisions" on public.experiment_revisions;
create policy "portal members read experiment revisions"
  on public.experiment_revisions for select to authenticated
  using (
    exists (
      select 1
      from public.experiments e
      where e.id = experiment_revisions.experiment_id
        and e.project_id = experiment_revisions.project_id
    )
  );

drop policy if exists "portal members read experiment assignments" on public.experiment_assignments;
create policy "portal members read experiment assignments"
  on public.experiment_assignments for select to authenticated
  using (
    exists (
      select 1
      from public.experiments e
      where e.id = experiment_assignments.experiment_id
        and e.project_id = experiment_assignments.project_id
    )
  );

drop policy if exists "portal members read experiment audit events" on public.experiment_audit_events;
create policy "portal members read experiment audit events"
  on public.experiment_audit_events for select to authenticated
  using (
    exists (
      select 1
      from public.experiments e
      where e.id = experiment_audit_events.experiment_id
        and e.project_id = experiment_audit_events.project_id
    )
  );

drop policy if exists "users read own builder requests" on public.experiment_builder_requests;
create policy "users read own builder requests"
  on public.experiment_builder_requests for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_portal_access(project_id)
  );

drop policy if exists "users create own builder requests" on public.experiment_builder_requests;
create policy "users create own builder requests"
  on public.experiment_builder_requests for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.current_portal_role(project_id) in ('admin', 'researcher')
  );

revoke all on table public.experiments from public, anon, authenticated;
revoke all on table public.experiment_revisions from public, anon, authenticated;
revoke all on table public.experiment_assignments from public, anon, authenticated;
revoke all on table public.experiment_audit_events from public, anon, authenticated;
revoke all on table public.experiment_builder_requests from public, anon, authenticated;

grant select on table public.experiments to authenticated;
grant select on table public.experiment_revisions to authenticated;
grant select on table public.experiment_assignments to authenticated;
grant select on table public.experiment_audit_events to authenticated;
grant select, insert on table public.experiment_builder_requests to authenticated;
grant select, insert, update, delete on table public.experiments to service_role;
grant select, insert, update, delete on table public.experiment_revisions to service_role;
grant select, insert, update, delete on table public.experiment_assignments to service_role;
grant select, insert, update, delete on table public.experiment_audit_events to service_role;
grant select, insert, update, delete on table public.experiment_builder_requests to service_role;

create or replace view public.portal_experiment_catalog
with (security_invoker = true)
as
select
  e.id,
  e.project_id,
  e.slug,
  e.name,
  e.description,
  e.mode,
  e.status,
  e.watering_state,
  e.visible_to_roles,
  e.started_at,
  e.ended_at,
  e.created_at,
  e.updated_at,
  e.current_revision_id,
  r.version as current_version,
  coalesce(
    (
      select array_agg(a.pairing_name order by a.zone, a.pot_number)
      from public.experiment_assignments a
      where a.revision_id = e.current_revision_id
    ),
    '{}'::text[]
  ) as pairing_names,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'pairing_name', a.pairing_name,
          'zone', a.zone,
          'pot_number', a.pot_number,
          'crop', a.crop,
          'treatment', a.treatment,
          'block', a.block,
          'substrate', a.substrate,
          'target_vwc_percent', a.target_vwc_percent,
          'measurement_interval_minutes', a.measurement_interval_minutes,
          'sensor_key_snapshot', a.sensor_key_snapshot,
          'valve_key_snapshot', a.valve_key_snapshot,
          'calibration_name_snapshot', a.calibration_name_snapshot
        )
        order by a.zone, a.pot_number
      )
      from public.experiment_assignments a
      where a.revision_id = e.current_revision_id
    ),
    '[]'::jsonb
  ) as assignments
from public.experiments e
left join public.experiment_revisions r on r.id = e.current_revision_id
where e.status <> 'archived';

revoke all on public.portal_experiment_catalog from public, anon;
grant select on public.portal_experiment_catalog to authenticated, service_role;

create or replace function public.publish_sensing_experiment(
  requested_project_id uuid,
  reviewed_spec jsonb,
  expected_inventory_updated_at timestamptz,
  draft_source text default 'manual',
  draft_model_name text default null,
  draft_prompt_fingerprint text default null
)
returns table (experiment_id uuid, experiment_slug text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text;
  record_project_id uuid;
  config_record public.device_config_state%rowtype;
  spec_name text;
  spec_description text;
  spec_mode text;
  spec_start_at timestamptz;
  spec_assignments jsonb;
  assignment_count integer;
  distinct_assignment_count integer;
  slug_base text;
  selected_slug text;
  suffix integer := 2;
  created_experiment_id uuid := gen_random_uuid();
  created_revision_id uuid := gen_random_uuid();
  config_pairing jsonb;
  assignment jsonb;
  assignment_name text;
  zone_match text[];
  selected_sensor_keys text[] := '{}'::text[];
  selected_valve_keys text[] := '{}'::text[];
  selected_sensor_key text;
  selected_valve_key text;
begin
  if caller_id is null then
    raise exception 'Authentication is required';
  end if;

  select pa.role
  into caller_role
  from public.portal_access pa
  where pa.user_id = caller_id
    and pa.project_id = requested_project_id
    and pa.role in ('admin', 'researcher')
  limit 1;

  if caller_role is null then
    raise exception 'Researcher or administrator access is required';
  end if;
  record_project_id := requested_project_id;

  if draft_source not in ('manual', 'natural_language') then
    raise exception 'Invalid draft source';
  end if;

  if jsonb_typeof(reviewed_spec) <> 'object' then
    raise exception 'Experiment specification must be an object';
  end if;

  spec_name := btrim(coalesce(reviewed_spec->>'name', ''));
  spec_description := btrim(coalesce(reviewed_spec->>'description', ''));
  spec_mode := coalesce(reviewed_spec->>'mode', 'observation');
  spec_assignments := reviewed_spec->'assignments';

  if char_length(spec_name) < 1 or char_length(spec_name) > 120 then
    raise exception 'Experiment name must include 1-120 characters';
  end if;
  if char_length(spec_description) > 300 then
    raise exception 'Experiment description is too long';
  end if;
  if spec_mode not in ('observation', 'calibration') then
    raise exception 'Only sensing-only observation or calibration experiments can be published';
  end if;
  if jsonb_typeof(reviewed_spec->'watering_requested') = 'boolean'
    and (reviewed_spec->>'watering_requested')::boolean then
    raise exception 'Watering cannot be enabled by the experiment builder';
  end if;
  if jsonb_typeof(spec_assignments) <> 'array' then
    raise exception 'Assignments must be a list';
  end if;

  assignment_count := jsonb_array_length(spec_assignments);
  if assignment_count < 1 or assignment_count > 100 then
    raise exception 'Select 1-100 pots';
  end if;

  select count(distinct item->>'pairing_name')
  into distinct_assignment_count
  from jsonb_array_elements(spec_assignments) item;
  if distinct_assignment_count <> assignment_count then
    raise exception 'Each pairing can be selected only once';
  end if;

  select d.*
  into config_record
  from public.device_config_state d
  where d.project_id = record_project_id
  order by d.updated_at desc
  limit 1;

  if config_record.project_id is null then
    raise exception 'Current device configuration is unavailable';
  end if;
  if expected_inventory_updated_at is null
    or config_record.updated_at <> expected_inventory_updated_at then
    raise exception 'The device inventory changed. Generate or review the draft again.';
  end if;

  if nullif(reviewed_spec->>'start_date', '') is not null then
    begin
      spec_start_at := (reviewed_spec->>'start_date')::timestamptz;
    exception when others then
      raise exception 'Start date is invalid';
    end;
  end if;

  slug_base := left(
    trim(both '-' from regexp_replace(lower(spec_name), '[^a-z0-9]+', '-', 'g')),
    72
  );
  if slug_base = '' then
    slug_base := 'experiment';
  end if;
  selected_slug := slug_base;
  while exists (
    select 1 from public.experiments e
    where e.project_id = record_project_id and e.slug = selected_slug
  ) loop
    selected_slug := left(slug_base, 72 - char_length(suffix::text) - 1) || '-' || suffix::text;
    suffix := suffix + 1;
  end loop;

  for assignment in select value from jsonb_array_elements(spec_assignments)
  loop
    assignment_name := btrim(coalesce(assignment->>'pairing_name', ''));
    select item
    into config_pairing
    from jsonb_array_elements(config_record.pairings) item
    where item->>'name' = assignment_name
    limit 1;

    if config_pairing is null then
      raise exception 'Pairing % is not in the current device inventory', assignment_name;
    end if;

    if coalesce(config_pairing->'Sensor'->>'boardSerialId', '') = ''
      or coalesce(config_pairing->'Sensor'->>'address', '') = ''
      or coalesce(config_pairing->'Valve'->>'relayAddress', '') = ''
      or coalesce(config_pairing->'Valve'->>'address', '') = '' then
      raise exception 'Pairing % does not have a complete sensor and valve mapping', assignment_name;
    end if;

    selected_sensor_key :=
      (config_pairing->'Sensor'->>'boardSerialId') || ':' ||
      (config_pairing->'Sensor'->>'address');
    selected_valve_key :=
      (config_pairing->'Valve'->>'relayAddress') || ':' ||
      (config_pairing->'Valve'->>'address');
    if selected_sensor_key = any(selected_sensor_keys) then
      raise exception 'Pairing % shares a sensor with another selected pot', assignment_name;
    end if;
    if selected_valve_key = any(selected_valve_keys) then
      raise exception 'Pairing % shares a valve with another selected pot', assignment_name;
    end if;
    selected_sensor_keys := array_append(selected_sensor_keys, selected_sensor_key);
    selected_valve_keys := array_append(selected_valve_keys, selected_valve_key);
  end loop;

  insert into public.experiments (
    id, project_id, slug, name, description, mode, status, watering_state,
    visible_to_roles, started_at, created_by
  ) values (
    created_experiment_id, record_project_id, selected_slug, spec_name,
    spec_description, spec_mode, 'published_sensing', 'off',
    array['admin', 'researcher']::text[], spec_start_at, caller_id
  );

  insert into public.experiment_revisions (
    id, experiment_id, project_id, version, source, spec,
    inventory_updated_at, inventory_hash, model_name, prompt_fingerprint, created_by
  ) values (
    created_revision_id, created_experiment_id, record_project_id, 1, draft_source,
    reviewed_spec || jsonb_build_object(
      'watering_requested', false,
      'watering_state', 'off'
    ),
    config_record.updated_at, config_record.config_hash, draft_model_name,
    draft_prompt_fingerprint, caller_id
  );

  for assignment in select value from jsonb_array_elements(spec_assignments)
  loop
    assignment_name := btrim(assignment->>'pairing_name');
    select item
    into config_pairing
    from jsonb_array_elements(config_record.pairings) item
    where item->>'name' = assignment_name
    limit 1;
    zone_match := regexp_match(assignment_name, '^Zone([0-9]+)-Pot([0-9]+)$', 'i');
    if zone_match is null then
      raise exception 'Pairing % does not use the expected Zone-Pot identity', assignment_name;
    end if;

    insert into public.experiment_assignments (
      revision_id, experiment_id, project_id, pairing_name, zone, pot_number,
      crop, treatment, block, substrate, target_vwc_percent,
      measurement_interval_minutes, notes, sensor_key_snapshot,
      valve_key_snapshot, calibration_name_snapshot, source_target_vwc_percent,
      source_valve_open_time_ms, source_measurement_interval_ms
    ) values (
      created_revision_id, created_experiment_id, record_project_id, assignment_name,
      zone_match[1]::integer, zone_match[2]::integer,
      nullif(btrim(assignment->>'crop'), ''),
      nullif(btrim(assignment->>'treatment'), ''),
      nullif(btrim(assignment->>'block'), ''),
      nullif(btrim(assignment->>'substrate'), ''),
      case when jsonb_typeof(assignment->'target_vwc_percent') = 'number'
        then (assignment->>'target_vwc_percent')::double precision else null end,
      case when jsonb_typeof(assignment->'measurement_interval_minutes') = 'number'
        then (assignment->>'measurement_interval_minutes')::double precision else null end,
      nullif(btrim(assignment->>'notes'), ''),
      (config_pairing->'Sensor'->>'boardSerialId') || ':' ||
        (config_pairing->'Sensor'->>'address'),
      (config_pairing->'Valve'->>'relayAddress') || ':' ||
        (config_pairing->'Valve'->>'address'),
      nullif(config_pairing->'Calibration'->>'name', ''),
      case when jsonb_typeof(config_pairing->'WTCPercentLimit') = 'number'
        then (config_pairing->>'WTCPercentLimit')::double precision else null end,
      case when jsonb_typeof(config_pairing->'ValveOpenTime') = 'number'
        then (config_pairing->>'ValveOpenTime')::integer else null end,
      case when jsonb_typeof(config_pairing->'MeasurementInterval') = 'number'
        then (config_pairing->>'MeasurementInterval')::integer else null end
    );
  end loop;

  update public.experiments
  set current_revision_id = created_revision_id, updated_at = now()
  where id = created_experiment_id;

  insert into public.experiment_audit_events (
    experiment_id, project_id, revision_id, event_type, actor_id, details
  ) values (
    created_experiment_id, record_project_id, created_revision_id,
    'published_sensing', caller_id,
    jsonb_build_object(
      'source', draft_source,
      'model', draft_model_name,
      'assignment_count', assignment_count,
      'watering_state', 'off'
    )
  );

  return query select created_experiment_id, selected_slug;
end;
$$;

revoke all on function public.publish_sensing_experiment(
  uuid, jsonb, timestamptz, text, text, text
) from public, anon;
grant execute on function public.publish_sensing_experiment(
  uuid, jsonb, timestamptz, text, text, text
) to authenticated;

comment on table public.experiments is
  'Portal experiment catalog. Builder-created experiments are sensing-only and never issue controller commands.';
comment on table public.experiment_revisions is
  'Immutable experiment specifications and inventory provenance.';
comment on function public.publish_sensing_experiment(uuid, jsonb, timestamptz, text, text, text) is
  'Publishes a validated sensing-only experiment from the current device inventory; never mutates controller state.';

-- Backfill the three currently visible portal experiments. Stable UUIDs make
-- this migration idempotent and keep existing slugs/URLs compatible.
insert into public.experiments (
  id, project_id, slug, name, description, mode, status, watering_state,
  visible_to_roles, started_at, ended_at
) values
  (
    'e1111111-1111-4111-8111-111111111111'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    'matt-experiment', 'Matt Experiment 1', 'Original 20-pot experiment',
    'controlled', 'completed', 'off', array['admin']::text[],
    null, '2026-07-23T14:46:34.000Z'::timestamptz
  ),
  (
    'e2222222-2222-4222-8222-222222222222'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    'matt-experiment-2', 'Matt Experiment 2', '24 pots · 30% target',
    'controlled', 'active', 'controller_managed', array['admin', 'researcher']::text[],
    null, null
  ),
  (
    'e3333333-3333-4333-8333-333333333333'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    'swc-saturation-calibration', 'SWC Saturation Calibration', '100% target · 10 s / 10 min',
    'calibration', 'active', 'controller_managed', array['admin', 'researcher']::text[],
    '2026-07-23T14:46:34.000Z'::timestamptz, null
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  visible_to_roles = excluded.visible_to_roles,
  updated_at = now();

insert into public.experiment_revisions (
  id, experiment_id, project_id, version, source, spec
) values
  (
    'f1111111-1111-4111-8111-111111111111'::uuid,
    'e1111111-1111-4111-8111-111111111111'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    1, 'legacy', '{"name":"Matt Experiment 1","mode":"controlled","watering_state":"off"}'::jsonb
  ),
  (
    'f2222222-2222-4222-8222-222222222222'::uuid,
    'e2222222-2222-4222-8222-222222222222'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    1, 'legacy', '{"name":"Matt Experiment 2","mode":"controlled","watering_state":"controller_managed"}'::jsonb
  ),
  (
    'f3333333-3333-4333-8333-333333333333'::uuid,
    'e3333333-3333-4333-8333-333333333333'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    1, 'legacy', '{"name":"SWC Saturation Calibration","mode":"calibration","watering_state":"controller_managed"}'::jsonb
  )
on conflict (id) do nothing;

with legacy_assignments(revision_id, experiment_id, pairing_name) as (
  select
    'f1111111-1111-4111-8111-111111111111'::uuid,
    'e1111111-1111-4111-8111-111111111111'::uuid,
    unnest(array[
      'Zone2-Pot41','Zone2-Pot42','Zone2-Pot43','Zone2-Pot44','Zone2-Pot45',
      'Zone2-Pot46','Zone2-Pot47','Zone2-Pot48','Zone2-Pot49','Zone2-Pot50',
      'Zone4-Pot91','Zone4-Pot92','Zone4-Pot93','Zone4-Pot94','Zone4-Pot95',
      'Zone4-Pot96','Zone4-Pot97','Zone4-Pot98','Zone4-Pot99','Zone4-Pot100'
    ]::text[])
  union all
  select
    'f2222222-2222-4222-8222-222222222222'::uuid,
    'e2222222-2222-4222-8222-222222222222'::uuid,
    unnest(array[
      'Zone1-Pot15','Zone1-Pot16','Zone1-Pot17','Zone1-Pot18','Zone1-Pot19',
      'Zone1-Pot20','Zone1-Pot21','Zone1-Pot22','Zone1-Pot23','Zone1-Pot24',
      'Zone1-Pot25','Zone2-Pot26','Zone3-Pot65','Zone3-Pot66','Zone3-Pot67',
      'Zone3-Pot68','Zone3-Pot69','Zone3-Pot70','Zone3-Pot71','Zone3-Pot72',
      'Zone3-Pot73','Zone3-Pot74','Zone3-Pot75','Zone4-Pot76'
    ]::text[])
  union all
  select
    'f3333333-3333-4333-8333-333333333333'::uuid,
    'e3333333-3333-4333-8333-333333333333'::uuid,
    unnest(array[
      'Zone2-Pot41','Zone2-Pot43','Zone2-Pot45','Zone2-Pot47','Zone2-Pot49',
      'Zone4-Pot91','Zone4-Pot93','Zone4-Pot95','Zone4-Pot97','Zone4-Pot99'
    ]::text[])
),
latest_config as (
  select d.*
  from public.device_config_state d
  where d.project_id = '22222222-2222-4222-8222-222222222222'::uuid
  order by d.updated_at desc
  limit 1
)
insert into public.experiment_assignments (
  revision_id, experiment_id, project_id, pairing_name, zone, pot_number,
  sensor_key_snapshot, valve_key_snapshot, calibration_name_snapshot,
  source_target_vwc_percent, source_valve_open_time_ms, source_measurement_interval_ms
)
select
  legacy.revision_id,
  legacy.experiment_id,
  '22222222-2222-4222-8222-222222222222'::uuid,
  legacy.pairing_name,
  (regexp_match(legacy.pairing_name, '^Zone([0-9]+)-Pot([0-9]+)$', 'i'))[1]::integer,
  (regexp_match(legacy.pairing_name, '^Zone([0-9]+)-Pot([0-9]+)$', 'i'))[2]::integer,
  coalesce(pairing.item->'Sensor'->>'boardSerialId', 'legacy') || ':' ||
    coalesce(pairing.item->'Sensor'->>'address', legacy.pairing_name),
  coalesce(pairing.item->'Valve'->>'relayAddress', 'legacy') || ':' ||
    coalesce(pairing.item->'Valve'->>'address', legacy.pairing_name),
  nullif(pairing.item->'Calibration'->>'name', ''),
  case when jsonb_typeof(pairing.item->'WTCPercentLimit') = 'number'
    then (pairing.item->>'WTCPercentLimit')::double precision else null end,
  case when jsonb_typeof(pairing.item->'ValveOpenTime') = 'number'
    then (pairing.item->>'ValveOpenTime')::integer else null end,
  case when jsonb_typeof(pairing.item->'MeasurementInterval') = 'number'
    then (pairing.item->>'MeasurementInterval')::integer else null end
from legacy_assignments legacy
cross join latest_config config
left join lateral (
  select item
  from jsonb_array_elements(config.pairings) item
  where item->>'name' = legacy.pairing_name
  limit 1
) pairing on true
on conflict (revision_id, pairing_name) do nothing;

update public.experiments
set current_revision_id = case id
  when 'e1111111-1111-4111-8111-111111111111'::uuid then 'f1111111-1111-4111-8111-111111111111'::uuid
  when 'e2222222-2222-4222-8222-222222222222'::uuid then 'f2222222-2222-4222-8222-222222222222'::uuid
  when 'e3333333-3333-4333-8333-333333333333'::uuid then 'f3333333-3333-4333-8333-333333333333'::uuid
end
where id in (
  'e1111111-1111-4111-8111-111111111111'::uuid,
  'e2222222-2222-4222-8222-222222222222'::uuid,
  'e3333333-3333-4333-8333-333333333333'::uuid
);

insert into public.experiment_audit_events (
  experiment_id, project_id, revision_id, event_type, details
)
select
  e.id, e.project_id, e.current_revision_id, 'legacy_imported',
  jsonb_build_object('slug', e.slug)
from public.experiments e
where e.id in (
  'e1111111-1111-4111-8111-111111111111'::uuid,
  'e2222222-2222-4222-8222-222222222222'::uuid,
  'e3333333-3333-4333-8333-333333333333'::uuid
)
and not exists (
  select 1 from public.experiment_audit_events audit
  where audit.experiment_id = e.id and audit.event_type = 'legacy_imported'
);

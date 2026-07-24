-- ExactH2O platform foundation v1.
--
-- This migration adds canonical physical identity, an operation ledger,
-- delivery-evidence records, tenant configuration, and notification delivery
-- state. It does not enqueue a command, change a pairing, change a target,
-- change watering, or mutate controller/Balena state.

create table if not exists public.project_platform_config (
  project_id uuid primary key references public.projects(id) on delete cascade,
  capability_contract_version text not null default '2026-07-24.1',
  display_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(display_config) = 'object'),
  control_policy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(control_policy) = 'object'),
  notification_policy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(notification_policy) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.project_platform_config (project_id)
select id from public.projects
on conflict (project_id) do nothing;

create table if not exists public.research_sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 120),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 80),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, slug),
  unique (id, project_id)
);

create table if not exists public.physical_positions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  site_id uuid not null,
  zone integer check (zone is null or zone between 1 and 1000),
  position_label text not null check (char_length(position_label) between 1 and 120),
  coordinates jsonb not null default '{}'::jsonb check (jsonb_typeof(coordinates) = 'object'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (site_id, project_id)
    references public.research_sites(id, project_id)
    on delete cascade,
  unique (project_id, site_id, position_label),
  unique (id, project_id)
);

create table if not exists public.research_pots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  site_id uuid not null,
  position_id uuid,
  pot_number integer not null check (pot_number between 1 and 100000),
  label text not null check (char_length(label) between 1 and 120),
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (site_id, project_id)
    references public.research_sites(id, project_id)
    on delete cascade,
  foreign key (position_id, project_id)
    references public.physical_positions(id, project_id)
    on delete restrict,
  unique (project_id, site_id, pot_number),
  unique (id, project_id)
);

create table if not exists public.hardware_bindings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id text not null,
  pot_id uuid not null,
  pairing_id bigint references public.pairings(id) on delete set null,
  pairing_name text not null check (char_length(pairing_name) between 1 and 120),
  sensor_key text not null check (char_length(sensor_key) between 1 and 160),
  valve_key text not null check (char_length(valve_key) between 1 and 160),
  physical_status text not null default 'software_only'
    check (physical_status in ('software_only', 'researcher_confirmed', 'delivery_verified', 'retired')),
  source text not null default 'pairing_snapshot'
    check (source in ('pairing_snapshot', 'researcher_confirmed', 'physical_verification', 'simulator')),
  effective_at timestamptz not null default now(),
  retired_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (pot_id, project_id)
    references public.research_pots(id, project_id)
    on delete cascade,
  check (retired_at is null or retired_at >= effective_at),
  unique (id, project_id)
);

create unique index if not exists hardware_bindings_active_pot_unique
  on public.hardware_bindings (project_id, pot_id)
  where retired_at is null;
create unique index if not exists hardware_bindings_active_pairing_unique
  on public.hardware_bindings (project_id, device_id, pairing_name)
  where retired_at is null;

insert into public.research_sites (
  organization_id, project_id, slug, name, timezone, metadata
)
select
  project.organization_id,
  project.id,
  'primary',
  project.name,
  'UTC',
  jsonb_build_object('source', 'platform_foundation_backfill')
from public.projects project
on conflict (project_id, slug) do nothing;

insert into public.physical_positions (
  project_id, site_id, zone, position_label, coordinates
)
select distinct
  pairing.project_id,
  site.id,
  pairing.zone,
  'Zone ' || pairing.zone::text || ' / Pot ' || pairing.pot_number::text,
  jsonb_build_object('zone', pairing.zone, 'pot_number', pairing.pot_number)
from public.pairings pairing
join public.research_sites site
  on site.project_id = pairing.project_id
 and site.slug = 'primary'
where pairing.zone is not null
  and pairing.pot_number is not null
on conflict (project_id, site_id, position_label) do nothing;

insert into public.research_pots (
  project_id, site_id, position_id, pot_number, label, metadata
)
select distinct on (pairing.project_id, pairing.pot_number)
  pairing.project_id,
  site.id,
  position.id,
  pairing.pot_number,
  'Pot ' || pairing.pot_number::text,
  jsonb_build_object('source', 'pairing_snapshot')
from public.pairings pairing
join public.research_sites site
  on site.project_id = pairing.project_id
 and site.slug = 'primary'
left join public.physical_positions position
  on position.project_id = pairing.project_id
 and position.site_id = site.id
 and position.position_label =
   'Zone ' || pairing.zone::text || ' / Pot ' || pairing.pot_number::text
where pairing.pot_number is not null
order by pairing.project_id, pairing.pot_number, pairing.updated_at desc
on conflict (project_id, site_id, pot_number) do update
set position_id = excluded.position_id,
    updated_at = now();

insert into public.hardware_bindings (
  project_id, device_id, pot_id, pairing_id, pairing_name,
  sensor_key, valve_key, physical_status, source, effective_at, metadata
)
select
  pairing.project_id,
  pairing.device_id,
  pot.id,
  pairing.id,
  pairing.name,
  pairing.sensor_key,
  pairing.valve_key,
  'software_only',
  'pairing_snapshot',
  pairing.updated_at,
  jsonb_build_object(
    'zone', pairing.zone,
    'pot_number', pairing.pot_number,
    'warning', 'Software identity only; physical delivery is not yet verified.'
  )
from public.pairings pairing
join public.research_sites site
  on site.project_id = pairing.project_id
 and site.slug = 'primary'
join public.research_pots pot
  on pot.project_id = pairing.project_id
 and pot.site_id = site.id
 and pot.pot_number = pairing.pot_number
where pairing.pot_number is not null
on conflict do nothing;

alter table public.experiment_assignments
  add column if not exists pot_id uuid;

update public.experiment_assignments assignment
set pot_id = pot.id
from public.research_sites site
join public.research_pots pot on pot.site_id = site.id
where assignment.pot_id is null
  and site.project_id = assignment.project_id
  and site.slug = 'primary'
  and pot.project_id = assignment.project_id
  and pot.pot_number = assignment.pot_number;

alter table public.experiment_assignments
  drop constraint if exists experiment_assignments_pot_fk;
alter table public.experiment_assignments
  add constraint experiment_assignments_pot_fk
  foreign key (pot_id, project_id)
  references public.research_pots(id, project_id)
  on delete restrict;

alter table public.calibration_studies
  drop constraint if exists calibration_studies_experiment_id_check;
alter table public.calibration_studies
  add constraint calibration_studies_experiment_id_check
  check (char_length(experiment_id) between 1 and 120);

create table if not exists public.platform_operations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  capability_id text not null check (char_length(capability_id) between 1 and 120),
  idempotency_key text check (
    idempotency_key is null or char_length(idempotency_key) between 1 and 200
  ),
  intent text not null check (char_length(intent) between 1 and 8000),
  specification jsonb not null default '{}'::jsonb
    check (jsonb_typeof(specification) = 'object'),
  approval_state text not null default 'draft'
    check (approval_state in ('draft', 'reviewed', 'approved', 'rejected', 'not_required')),
  execution_state text not null default 'planned'
    check (
      execution_state in (
        'planned', 'queued', 'claimed', 'running', 'completed',
        'completed_unverified', 'verified', 'failed', 'canceled'
      )
    ),
  verification_state text not null default 'not_required'
    check (verification_state in ('not_required', 'pending', 'verified', 'failed', 'unavailable')),
  correlation_id uuid not null default gen_random_uuid(),
  parent_operation_id uuid references public.platform_operations(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (correlation_id),
  unique (project_id, requested_by, idempotency_key),
  unique (id, project_id),
  check (
    (approval_state = 'approved' and approved_at is not null and approved_by is not null)
    or approval_state <> 'approved'
  )
);

create table if not exists public.platform_operation_links (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null,
  project_id uuid not null,
  resource_type text not null check (
    resource_type in (
      'assistant_request', 'assistant_thread', 'experiment', 'revision',
      'control_plan', 'control_command', 'control_batch', 'schedule', 'schedule_run',
      'monitor', 'monitor_event', 'calibration_study', 'calibration_request',
      'delivery_evidence', 'notification'
    )
  ),
  resource_id text not null check (char_length(resource_id) between 1 and 200),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  foreign key (operation_id, project_id)
    references public.platform_operations(id, project_id)
    on delete cascade,
  unique (project_id, resource_type, resource_id)
);

create table if not exists public.platform_operation_events (
  id bigint generated always as identity primary key,
  operation_id uuid not null,
  project_id uuid not null,
  event_type text not null check (char_length(event_type) between 1 and 120),
  state text not null check (char_length(state) between 1 and 80),
  summary text not null check (char_length(summary) between 1 and 500),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  actor_type text not null default 'system'
    check (actor_type in ('user', 'assistant', 'controller', 'system', 'simulator')),
  actor_id uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (operation_id, project_id)
    references public.platform_operations(id, project_id)
    on delete cascade
);

create index if not exists platform_operations_project_created_idx
  on public.platform_operations (project_id, created_at desc);
create index if not exists platform_operation_events_operation_time_idx
  on public.platform_operation_events (operation_id, occurred_at asc, id asc);

create table if not exists public.delivery_evidence (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  operation_id uuid,
  command_id uuid references public.project_control_commands(id) on delete set null,
  valve_event_id bigint references public.valve_events(id) on delete set null,
  pot_id uuid,
  pairing_name text,
  evidence_type text not null
    check (evidence_type in ('flow', 'weight', 'pressure', 'reservoir_mass', 'manual', 'simulator')),
  source_id text not null check (char_length(source_id) between 1 and 160),
  observed_at timestamptz not null,
  value double precision,
  unit text check (unit is null or char_length(unit) <= 40),
  expected_value double precision,
  tolerance double precision,
  verification_result text not null default 'observed'
    check (verification_result in ('observed', 'verified', 'mismatch', 'inconclusive')),
  raw_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_evidence) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (operation_id, project_id)
    references public.platform_operations(id, project_id)
    on delete restrict,
  foreign key (pot_id, project_id)
    references public.research_pots(id, project_id)
    on delete restrict,
  unique (project_id, evidence_type, source_id)
);

comment on table public.delivery_evidence is
  'Independent physical or simulator evidence. Valve events alone do not prove physical water delivery.';

create table if not exists public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('portal', 'email')),
  destination text,
  enabled boolean not null default true,
  event_types text[] not null default array['monitor_triggered', 'operation_failed']::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, user_id, channel)
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid,
  event_type text not null check (char_length(event_type) between 1 and 120),
  channel text not null check (channel in ('portal', 'email')),
  destination text,
  subject text not null check (char_length(subject) between 1 and 200),
  body text not null check (char_length(body) between 1 and 8000),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'delivered', 'failed', 'canceled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  delivered_at timestamptz,
  provider_id text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (operation_id, project_id)
    references public.platform_operations(id, project_id)
    on delete restrict
);

create table if not exists public.notification_delivery_attempts (
  id bigint generated always as identity primary key,
  notification_id uuid not null references public.notification_outbox(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  status text not null check (status in ('delivered', 'failed')),
  provider_id text,
  error text,
  response_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(response_metadata) = 'object')
);

create or replace function public.claim_notification_outbox(
  claim_limit integer default 25,
  claim_seconds integer default 120
)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may claim notifications';
  end if;

  return query
  with selected as (
    select notification.id
    from public.notification_outbox notification
    where notification.channel = 'email'
      and notification.attempt_count < 20
      and notification.next_attempt_at <= now()
      and (
        notification.status = 'pending'
        or (
          notification.status = 'sending'
          and notification.lease_until < now()
        )
      )
    order by notification.next_attempt_at, notification.created_at
    for update skip locked
    limit least(greatest(claim_limit, 1), 100)
  )
  update public.notification_outbox notification
  set
    status = 'sending',
    lease_until = now() + make_interval(
      secs => least(greatest(claim_seconds, 30), 600)
    ),
    attempt_count = notification.attempt_count + 1,
    updated_at = now()
  from selected
  where notification.id = selected.id
  returning notification.*;
end;
$$;

insert into public.notification_preferences (
  project_id, user_id, channel, enabled, event_types
)
select
  access.project_id,
  access.user_id,
  'portal',
  true,
  array['monitor_triggered', 'operation_failed']::text[]
from public.portal_access access
on conflict (project_id, user_id, channel) do nothing;

create or replace function public.ensure_portal_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.notification_preferences (
    project_id, user_id, channel, enabled, event_types
  ) values (
    new.project_id,
    new.user_id,
    'portal',
    true,
    array['monitor_triggered', 'operation_failed']::text[]
  )
  on conflict (project_id, user_id, channel) do nothing;
  return new;
end;
$$;

drop trigger if exists portal_access_notification_preference
  on public.portal_access;
create trigger portal_access_notification_preference
after insert on public.portal_access
for each row execute function public.ensure_portal_notification_preference();

create or replace function public.set_notification_preference(
  selected_project_id uuid,
  selected_channel text,
  selected_enabled boolean,
  selected_destination text default null,
  selected_event_types text[] default array['monitor_triggered', 'operation_failed']::text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_user_id uuid := auth.uid();
  preference_id uuid;
  normalized_destination text := nullif(lower(trim(selected_destination)), '');
begin
  if selected_user_id is null or not public.has_portal_access(selected_project_id) then
    raise exception 'Portal access is required';
  end if;
  if selected_channel not in ('portal', 'email') then
    raise exception 'Unsupported notification channel';
  end if;
  if selected_channel = 'email' and (
    normalized_destination is null
    or normalized_destination !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    raise exception 'A valid email destination is required';
  end if;
  if selected_event_types <@ array['monitor_triggered', 'operation_failed']::text[] is not true then
    raise exception 'Unsupported notification event type';
  end if;

  insert into public.notification_preferences (
    project_id, user_id, channel, destination, enabled, event_types
  ) values (
    selected_project_id,
    selected_user_id,
    selected_channel,
    case when selected_channel = 'email' then normalized_destination else null end,
    selected_enabled,
    selected_event_types
  )
  on conflict (project_id, user_id, channel) do update
  set
    destination = excluded.destination,
    enabled = excluded.enabled,
    event_types = excluded.event_types,
    updated_at = now()
  returning id into preference_id;

  return preference_id;
end;
$$;

create or replace function public.record_platform_operation_event(
  selected_operation_id uuid,
  selected_project_id uuid,
  selected_event_type text,
  selected_state text,
  selected_summary text,
  selected_evidence jsonb default '{}'::jsonb,
  selected_actor_type text default 'system',
  selected_actor_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_event_id bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may append operation events';
  end if;

  insert into public.platform_operation_events (
    operation_id, project_id, event_type, state, summary,
    evidence, actor_type, actor_id
  ) values (
    selected_operation_id, selected_project_id, selected_event_type,
    selected_state, selected_summary, coalesce(selected_evidence, '{}'::jsonb),
    selected_actor_type, selected_actor_id
  )
  returning id into created_event_id;

  return created_event_id;
end;
$$;

create or replace function public.link_platform_operation_resource(
  selected_operation_id uuid,
  selected_project_id uuid,
  selected_resource_type text,
  selected_resource_id text,
  selected_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_link_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may link operation resources';
  end if;

  insert into public.platform_operation_links (
    operation_id, project_id, resource_type, resource_id, metadata
  ) values (
    selected_operation_id, selected_project_id, selected_resource_type,
    selected_resource_id, coalesce(selected_metadata, '{}'::jsonb)
  )
  on conflict (project_id, resource_type, resource_id) do update
  set operation_id = excluded.operation_id,
      metadata = excluded.metadata
  returning id into created_link_id;

  return created_link_id;
end;
$$;

create or replace function public.capture_control_command_operation_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_operation_id uuid;
  command_total integer := 0;
  queued_count integer := 0;
  accepted_count integer := 0;
  running_count integer := 0;
  succeeded_count integer := 0;
  failed_count integer := 0;
  canceled_count integer := 0;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  select link.operation_id
  into selected_operation_id
  from public.platform_operation_links link
  where link.project_id = new.project_id
    and (
      (link.resource_type = 'control_command' and link.resource_id = new.id::text)
      or
      (
        new.batch_id is not null
        and link.resource_type = 'control_batch'
        and link.resource_id = new.batch_id::text
      )
    )
  order by case when link.resource_type = 'control_command' then 0 else 1 end
  limit 1;

  if selected_operation_id is null then
    return new;
  end if;

  insert into public.platform_operation_events (
    operation_id, project_id, event_type, state, summary, evidence, actor_type, occurred_at
  ) values (
    selected_operation_id,
    new.project_id,
    'control_command.' || new.status,
    new.status,
    'Controller command ' || new.command_type || ' is ' || new.status || '.',
    jsonb_build_object(
      'command_id', new.id,
      'command_type', new.command_type,
      'batch_id', new.batch_id,
      'error', new.error,
      'result', new.result
    ),
    'controller',
    coalesce(new.completed_at, new.started_at, new.requested_at, now())
  );

  with linked_commands as (
    select distinct command.id, command.status
    from public.project_control_commands command
    join public.platform_operation_links link
      on link.project_id = command.project_id
     and (
       (
         link.resource_type = 'control_command'
         and link.resource_id = command.id::text
       )
       or
       (
         link.resource_type = 'control_batch'
         and command.batch_id is not null
         and link.resource_id = command.batch_id::text
       )
     )
    where link.operation_id = selected_operation_id
      and command.project_id = new.project_id
  )
  select
    count(*),
    count(*) filter (where status = 'queued'),
    count(*) filter (where status = 'accepted'),
    count(*) filter (where status = 'running'),
    count(*) filter (where status = 'succeeded'),
    count(*) filter (where status in ('failed', 'expired')),
    count(*) filter (where status = 'canceled')
  into
    command_total,
    queued_count,
    accepted_count,
    running_count,
    succeeded_count,
    failed_count,
    canceled_count
  from linked_commands;

  update public.platform_operations operation
  set
    execution_state = case
      when failed_count > 0 then 'failed'
      when canceled_count = command_total and command_total > 0 then 'canceled'
      when canceled_count > 0
        and succeeded_count + canceled_count = command_total then 'failed'
      when running_count > 0 then 'running'
      when accepted_count > 0 then 'claimed'
      when queued_count > 0 then 'queued'
      when succeeded_count = command_total and command_total > 0 then
        case
          when operation.verification_state = 'pending' then 'completed_unverified'
          else 'completed'
        end
      else operation.execution_state
    end,
    started_at = case
      when accepted_count > 0 or running_count > 0 or succeeded_count > 0
        then coalesce(operation.started_at, new.started_at, now())
      else operation.started_at
    end,
    completed_at = case
      when failed_count > 0
        or (command_total > 0 and succeeded_count + canceled_count = command_total)
        then coalesce(operation.completed_at, new.completed_at, now())
      else operation.completed_at
    end,
    error_message = case
      when new.status in ('failed', 'expired') then new.error
      when canceled_count > 0 and succeeded_count + canceled_count = command_total
        then 'One or more commands were canceled.'
      else operation.error_message
    end,
    updated_at = now()
  where operation.id = selected_operation_id;

  return new;
end;
$$;

drop trigger if exists project_control_commands_operation_event
  on public.project_control_commands;
create trigger project_control_commands_operation_event
after insert or update of status on public.project_control_commands
for each row execute function public.capture_control_command_operation_event();

create or replace function public.enqueue_monitor_portal_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.state <> 'triggered' then
    return new;
  end if;

  insert into public.notification_outbox (
    project_id, user_id, event_type, channel, destination,
    subject, body, status, metadata
  )
  select
    monitor.project_id,
    preference.user_id,
    'monitor_triggered',
    preference.channel,
    preference.destination,
    monitor.name,
    new.summary,
    case when preference.channel = 'portal' then 'delivered' else 'pending' end,
    jsonb_build_object('monitor_id', monitor.id, 'monitor_event_id', new.id)
  from public.assistant_monitors monitor
  join public.notification_preferences preference
    on preference.project_id = monitor.project_id
   and preference.enabled
   and 'monitor_triggered' = any(preference.event_types)
  where monitor.id = new.monitor_id;

  return new;
end;
$$;

drop trigger if exists assistant_monitor_events_notify
  on public.assistant_monitor_events;
create trigger assistant_monitor_events_notify
after insert on public.assistant_monitor_events
for each row execute function public.enqueue_monitor_portal_notification();

create or replace function public.enqueue_operation_failure_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.execution_state <> 'failed'
     or new.execution_state is not distinct from old.execution_state then
    return new;
  end if;

  insert into public.notification_outbox (
    project_id, user_id, operation_id, event_type, channel, destination,
    subject, body, status, metadata
  )
  select
    new.project_id,
    preference.user_id,
    new.id,
    'operation_failed',
    preference.channel,
    preference.destination,
    'ExactH2O operation needs attention',
    coalesce(new.error_message, new.intent),
    case when preference.channel = 'portal' then 'delivered' else 'pending' end,
    jsonb_build_object(
      'operation_id', new.id,
      'capability_id', new.capability_id,
      'correlation_id', new.correlation_id
    )
  from public.notification_preferences preference
  where preference.project_id = new.project_id
    and preference.enabled
    and 'operation_failed' = any(preference.event_types);

  return new;
end;
$$;

drop trigger if exists platform_operations_failure_notify
  on public.platform_operations;
create trigger platform_operations_failure_notify
after update of execution_state on public.platform_operations
for each row execute function public.enqueue_operation_failure_notification();

create or replace view public.portal_identity_reconciliation
with (security_invoker = true)
as
select
  assignment.project_id,
  assignment.experiment_id,
  assignment.revision_id,
  assignment.pairing_name as assigned_pairing_name,
  assignment.pot_number as assigned_pot_number,
  assignment.sensor_key_snapshot,
  assignment.valve_key_snapshot,
  assignment.pot_id,
  binding.id as binding_id,
  binding.pairing_name as current_pairing_name,
  binding.sensor_key as current_sensor_key,
  binding.valve_key as current_valve_key,
  binding.physical_status,
  case
    when assignment.pot_id is null then 'missing_canonical_pot'
    when binding.id is null then 'missing_hardware_binding'
    when binding.pairing_name <> assignment.pairing_name then 'pairing_name_changed'
    when binding.sensor_key <> assignment.sensor_key_snapshot then 'sensor_changed'
    when binding.valve_key <> assignment.valve_key_snapshot then 'valve_changed'
    when binding.physical_status = 'software_only' then 'software_only'
    else 'matched'
  end as reconciliation_state
from public.experiment_assignments assignment
left join public.hardware_bindings binding
  on binding.project_id = assignment.project_id
 and binding.pot_id = assignment.pot_id
 and binding.retired_at is null;

create or replace view public.portal_operation_timeline
with (security_invoker = true)
as
select
  operation.id,
  operation.project_id,
  operation.requested_by,
  operation.capability_id,
  operation.intent,
  operation.approval_state,
  operation.execution_state,
  operation.verification_state,
  operation.correlation_id,
  operation.created_at,
  operation.updated_at,
  operation.completed_at,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'event_type', event.event_type,
          'state', event.state,
          'summary', event.summary,
          'evidence', event.evidence,
          'actor_type', event.actor_type,
          'occurred_at', event.occurred_at
        )
        order by event.occurred_at, event.id
      )
      from public.platform_operation_events event
      where event.operation_id = operation.id
    ),
    '[]'::jsonb
  ) as events
from public.platform_operations operation;

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
          'pot_id', a.pot_id,
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

alter table public.project_platform_config enable row level security;
alter table public.research_sites enable row level security;
alter table public.physical_positions enable row level security;
alter table public.research_pots enable row level security;
alter table public.hardware_bindings enable row level security;
alter table public.platform_operations enable row level security;
alter table public.platform_operation_links enable row level security;
alter table public.platform_operation_events enable row level security;
alter table public.delivery_evidence enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.notification_delivery_attempts enable row level security;

create policy "portal members read platform config"
  on public.project_platform_config for select to authenticated
  using (public.has_portal_access(project_id));
create policy "portal members read research sites"
  on public.research_sites for select to authenticated
  using (public.has_portal_access(project_id));
create policy "portal members read physical positions"
  on public.physical_positions for select to authenticated
  using (public.has_portal_access(project_id));
create policy "portal members read research pots"
  on public.research_pots for select to authenticated
  using (public.has_portal_access(project_id));
create policy "portal members read hardware bindings"
  on public.hardware_bindings for select to authenticated
  using (public.has_portal_access(project_id));
create policy "users read own operations"
  on public.platform_operations for select to authenticated
  using (
    public.has_portal_access(project_id)
    and (
      requested_by = (select auth.uid())
      or public.current_portal_role(project_id) = 'admin'
    )
  );
create policy "users read own operation links"
  on public.platform_operation_links for select to authenticated
  using (
    exists (
      select 1
      from public.platform_operations operation
      where operation.id = platform_operation_links.operation_id
    )
  );
create policy "users read own operation events"
  on public.platform_operation_events for select to authenticated
  using (
    exists (
      select 1
      from public.platform_operations operation
      where operation.id = platform_operation_events.operation_id
    )
  );
create policy "portal members read delivery evidence"
  on public.delivery_evidence for select to authenticated
  using (public.has_portal_access(project_id));
create policy "users read own notification preferences"
  on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()) and public.has_portal_access(project_id));
create policy "users update own notification preferences"
  on public.notification_preferences for update to authenticated
  using (user_id = (select auth.uid()) and public.has_portal_access(project_id))
  with check (user_id = (select auth.uid()) and public.has_portal_access(project_id));
create policy "users read own notifications"
  on public.notification_outbox for select to authenticated
  using (user_id = (select auth.uid()) and public.has_portal_access(project_id));
create policy "users read own notification attempts"
  on public.notification_delivery_attempts for select to authenticated
  using (
    exists (
      select 1
      from public.notification_outbox notification
      where notification.id = notification_delivery_attempts.notification_id
        and notification.user_id = (select auth.uid())
        and public.has_portal_access(notification.project_id)
    )
  );

revoke all on public.project_platform_config from public, anon, authenticated;
revoke all on public.research_sites from public, anon, authenticated;
revoke all on public.physical_positions from public, anon, authenticated;
revoke all on public.research_pots from public, anon, authenticated;
revoke all on public.hardware_bindings from public, anon, authenticated;
revoke all on public.platform_operations from public, anon, authenticated;
revoke all on public.platform_operation_links from public, anon, authenticated;
revoke all on public.platform_operation_events from public, anon, authenticated;
revoke all on public.delivery_evidence from public, anon, authenticated;
revoke all on public.notification_preferences from public, anon, authenticated;
revoke all on public.notification_outbox from public, anon, authenticated;
revoke all on public.notification_delivery_attempts from public, anon, authenticated;

grant select on public.project_platform_config to authenticated, service_role;
grant select on public.research_sites to authenticated, service_role;
grant select on public.physical_positions to authenticated, service_role;
grant select on public.research_pots to authenticated, service_role;
grant select on public.hardware_bindings to authenticated, service_role;
grant select on public.platform_operations to authenticated, service_role;
grant select on public.platform_operation_links to authenticated, service_role;
grant select on public.platform_operation_events to authenticated, service_role;
grant select on public.delivery_evidence to authenticated, service_role;
grant select, update on public.notification_preferences to authenticated;
grant select on public.notification_outbox to authenticated;
grant select on public.notification_delivery_attempts to authenticated;

grant insert, update, delete on public.project_platform_config to service_role;
grant insert, update, delete on public.research_sites to service_role;
grant insert, update, delete on public.physical_positions to service_role;
grant insert, update, delete on public.research_pots to service_role;
grant insert, update, delete on public.hardware_bindings to service_role;
grant insert, update, delete on public.platform_operations to service_role;
grant insert, update, delete on public.platform_operation_links to service_role;
grant insert, update, delete on public.platform_operation_events to service_role;
grant insert, update, delete on public.delivery_evidence to service_role;
grant insert, update, delete on public.notification_preferences to service_role;
grant insert, update, delete on public.notification_outbox to service_role;
grant insert, update, delete on public.notification_delivery_attempts to service_role;

revoke all on public.portal_identity_reconciliation from public, anon;
revoke all on public.portal_operation_timeline from public, anon;
revoke all on public.portal_experiment_catalog from public, anon;
grant select on public.portal_identity_reconciliation to authenticated, service_role;
grant select on public.portal_operation_timeline to authenticated, service_role;
grant select on public.portal_experiment_catalog to authenticated, service_role;

revoke all on function public.record_platform_operation_event(
  uuid, uuid, text, text, text, jsonb, text, uuid
) from public, anon, authenticated;
revoke all on function public.link_platform_operation_resource(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.claim_notification_outbox(integer, integer)
  from public, anon, authenticated;
revoke all on function public.set_notification_preference(
  uuid, text, boolean, text, text[]
) from public, anon, authenticated;
grant execute on function public.record_platform_operation_event(
  uuid, uuid, text, text, text, jsonb, text, uuid
) to service_role;
grant execute on function public.link_platform_operation_resource(
  uuid, uuid, text, text, jsonb
) to service_role;
grant execute on function public.claim_notification_outbox(integer, integer)
  to service_role;
grant execute on function public.set_notification_preference(
  uuid, text, boolean, text, text[]
) to authenticated, service_role;

comment on table public.platform_operations is
  'Canonical operation ledger: request, reviewed specification, approval, execution, and verification state.';
comment on table public.hardware_bindings is
  'Versioned software-to-physical identity binding. Physical status remains software_only until independently confirmed.';
comment on view public.portal_identity_reconciliation is
  'Compares experiment assignment snapshots with current canonical hardware bindings.';

-- Revision-aware experiment editing.
--
-- Every edit creates an immutable revision and a reviewed controller plan in
-- one transaction. Only the service-role edge function may call the write RPC.
-- Controller commands remain dependency ordered and fail closed.

alter table public.experiment_audit_events
  drop constraint if exists experiment_audit_events_event_type_check;
alter table public.experiment_audit_events
  add constraint experiment_audit_events_event_type_check
  check (
    event_type in (
      'legacy_imported',
      'published_sensing',
      'revision_created',
      'activation_requested',
      'activation_succeeded',
      'activation_failed',
      'archived'
    )
  );

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
  ) as assignments,
  r.spec as current_spec
from public.experiments e
left join public.experiment_revisions r on r.id = e.current_revision_id
where e.status <> 'archived';

revoke all on public.portal_experiment_catalog from public, anon;
grant select on public.portal_experiment_catalog to authenticated, service_role;

create or replace function public.attach_experiment_control_plan(
  requested_experiment_id uuid,
  requested_actor_id uuid,
  reviewed_spec jsonb,
  compiled_plan jsonb,
  expected_inventory_updated_at timestamptz,
  expected_config_hash text
)
returns table (plan_id uuid, batch_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  experiment_record public.experiments%rowtype;
  config_record public.device_config_state%rowtype;
  created_plan_id uuid := gen_random_uuid();
  created_batch_id uuid := gen_random_uuid();
  commands jsonb;
  command_count integer;
  command_item jsonb;
  command_index integer := 0;
  selected_pairings text[];
  command_pairing text;
  final_watering text;
  requested_mode text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may attach a controller plan';
  end if;
  if not exists (
    select 1 from public.portal_access access
    where access.project_id = (
      select project_id from public.experiments where id = requested_experiment_id
    )
      and access.user_id = requested_actor_id
      and access.role in ('admin', 'researcher')
  ) then
    raise exception 'Experiment settings access is required';
  end if;

  select *
  into experiment_record
  from public.experiments
  where id = requested_experiment_id
    and status in ('published_sensing', 'active', 'activation_failed')
  for update;
  if experiment_record.id is null then
    raise exception 'The experiment is not available for activation';
  end if;
  if exists (
    select 1
    from public.experiment_control_plans plan
    where plan.experiment_id = experiment_record.id
      and plan.status in ('prepared', 'queued', 'executing')
  ) then
    raise exception 'The experiment already has controller changes in progress';
  end if;

  select *
  into config_record
  from public.device_config_state
  where project_id = experiment_record.project_id
  order by updated_at desc
  limit 1;
  if config_record.project_id is null
    or config_record.updated_at is distinct from expected_inventory_updated_at
    or config_record.config_hash is distinct from expected_config_hash then
    raise exception 'Controller configuration changed before activation';
  end if;

  requested_mode := coalesce(reviewed_spec->>'mode', 'observation');
  if requested_mode not in ('controlled', 'observation', 'calibration') then
    raise exception 'Experiment mode is invalid';
  end if;
  if jsonb_typeof(reviewed_spec->'assignments') <> 'array'
    or jsonb_array_length(reviewed_spec->'assignments') < 1 then
    raise exception 'Experiment assignments are required';
  end if;

  select array_agg(item->>'pairing_name' order by item->>'pairing_name')
  into selected_pairings
  from jsonb_array_elements(reviewed_spec->'assignments') item;
  if array_length(selected_pairings, 1) is distinct from (
    select count(distinct item->>'pairing_name')
    from jsonb_array_elements(reviewed_spec->'assignments') item
  ) then
    raise exception 'Experiment pairings must be unique';
  end if;

  commands := compiled_plan->'commands';
  if jsonb_typeof(commands) <> 'array' then
    raise exception 'Controller plan commands are required';
  end if;
  command_count := jsonb_array_length(commands);
  if command_count > 60 then
    raise exception 'Controller plan is too large';
  end if;
  if command_count > 0 then
    if commands->0->>'command_type' <> 'update_system_state'
      or commands->0->'payload'->>'state' <> 'stopped'
      or commands->(command_count - 1)->>'command_type' <> 'update_system_state'
      or commands->(command_count - 1)->'payload'->>'state' <> 'running' then
      raise exception 'Controller plans must stop before editing and resume last';
    end if;
  end if;

  for command_item in select value from jsonb_array_elements(commands)
  loop
    command_index := command_index + 1;
    if command_item->>'command_type' not in (
      'update_system_state',
      'bulk_update_pairings'
    ) then
      raise exception 'Controller plan contains an unsupported command';
    end if;
    if (command_item->>'client_request_id')::uuid is null then
      raise exception 'Controller plan command ID is invalid';
    end if;

    if command_item->>'command_type' = 'bulk_update_pairings' then
      if jsonb_typeof(command_item->'payload'->'pairing_names') <> 'array' then
        raise exception 'Controller update pairings are invalid';
      end if;
      for command_pairing in
        select jsonb_array_elements_text(command_item->'payload'->'pairing_names')
      loop
        if not command_pairing = any(selected_pairings) then
          raise exception 'Controller plan includes an unreviewed pairing %', command_pairing;
        end if;
      end loop;
      if (command_item->'payload' ? 'target_vwc')
        and (
          (command_item->'payload'->>'target_vwc')::double precision < 0
          or (command_item->'payload'->>'target_vwc')::double precision > 80
        ) then
        raise exception 'Controller plan target is outside 0-80 percent';
      end if;
      if (command_item->'payload' ? 'open_time_seconds')
        and (
          (command_item->'payload'->>'open_time_seconds')::double precision < 1
          or (command_item->'payload'->>'open_time_seconds')::double precision > 120
        ) then
        raise exception 'Controller plan valve time is outside 1-120 seconds';
      end if;
      if not (command_item->'payload' ? 'measurement_interval_seconds')
        or (command_item->'payload'->>'measurement_interval_seconds')::double precision < 30
        or (command_item->'payload'->>'measurement_interval_seconds')::double precision > 3600 then
        raise exception 'Controller plan interval is outside 30-3600 seconds';
      end if;
    end if;
  end loop;

  select case when exists (
    select 1
    from jsonb_array_elements(reviewed_spec->'assignments') assignment
    where coalesce((assignment->>'watering_enabled')::boolean, false)
  ) then 'controller_managed' else 'off' end
  into final_watering;

  insert into public.experiment_control_plans (
    id, experiment_id, project_id, batch_id, status, expected_step_count,
    expected_inventory_updated_at, expected_config_hash, final_watering_state,
    created_by, confirmed_at
  ) values (
    created_plan_id, experiment_record.id, experiment_record.project_id,
    created_batch_id, case when command_count = 0 then 'active' else 'prepared' end,
    command_count, expected_inventory_updated_at, expected_config_hash,
    final_watering, requested_actor_id, now()
  );

  command_index := 0;
  for command_item in select value from jsonb_array_elements(commands)
  loop
    command_index := command_index + 1;
    insert into public.experiment_control_plan_steps (
      plan_id, project_id, sequence, label, command_type, payload, confirm,
      client_request_id
    ) values (
      created_plan_id,
      experiment_record.project_id,
      command_index,
      left(coalesce(nullif(command_item->>'label', ''), 'Controller update'), 160),
      command_item->>'command_type',
      command_item->'payload',
      coalesce((command_item->>'confirm')::boolean, false),
      (command_item->>'client_request_id')::uuid
    );
  end loop;

  update public.experiments
  set mode = requested_mode,
      status = case when command_count = 0 then 'active' else 'activating' end,
      watering_state = case when command_count = 0 then final_watering else 'off' end,
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = experiment_record.id;

  update public.experiment_revisions
  set spec = reviewed_spec || jsonb_build_object(
    'control_plan_id', created_plan_id,
    'control_batch_id', created_batch_id
  )
  where id = experiment_record.current_revision_id;

  insert into public.experiment_audit_events (
    experiment_id, project_id, revision_id, event_type, actor_id, details
  ) values (
    experiment_record.id,
    experiment_record.project_id,
    experiment_record.current_revision_id,
    'activation_requested',
    requested_actor_id,
    jsonb_build_object(
      'plan_id', created_plan_id,
      'batch_id', created_batch_id,
      'command_count', command_count,
      'config_hash', expected_config_hash
    )
  );

  if command_count = 0 then
    perform public.reconcile_experiment_control_plan(created_plan_id);
  end if;
  return query select created_plan_id, created_batch_id;
end;
$$;

revoke all on function public.attach_experiment_control_plan(
  uuid, uuid, jsonb, jsonb, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.attach_experiment_control_plan(
  uuid, uuid, jsonb, jsonb, timestamptz, text
) to service_role;

create or replace function public.revise_and_attach_experiment(
  requested_experiment_id uuid,
  requested_actor_id uuid,
  expected_revision_id uuid,
  reviewed_spec jsonb,
  compiled_plan jsonb,
  expected_inventory_updated_at timestamptz,
  expected_config_hash text,
  revision_source text default 'manual',
  revision_model_name text default null,
  revision_prompt_fingerprint text default null
)
returns table (
  experiment_id uuid,
  experiment_slug text,
  revision_id uuid,
  revision_version integer,
  plan_id uuid,
  batch_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  experiment_record public.experiments%rowtype;
  config_record public.device_config_state%rowtype;
  created_revision_id uuid := gen_random_uuid();
  created_plan record;
  next_version integer;
  spec_name text;
  spec_description text;
  spec_mode text;
  spec_start_at timestamptz;
  spec_assignments jsonb;
  assignment_count integer;
  assignment jsonb;
  assignment_name text;
  config_pairing jsonb;
  zone_match text[];
  selected_sensor_keys text[] := '{}'::text[];
  selected_valve_keys text[] := '{}'::text[];
  selected_sensor_key text;
  selected_valve_key text;
  selected_pot_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may revise an experiment';
  end if;
  if revision_source not in ('manual', 'natural_language') then
    raise exception 'Invalid revision source';
  end if;

  select *
  into experiment_record
  from public.experiments
  where id = requested_experiment_id
    and current_revision_id = expected_revision_id
    and status in ('published_sensing', 'active', 'activation_failed')
  for update;
  if experiment_record.id is null then
    raise exception 'This experiment changed or is not currently editable';
  end if;
  if not exists (
    select 1
    from public.portal_access access
    where access.project_id = experiment_record.project_id
      and access.user_id = requested_actor_id
      and access.role in ('admin', 'researcher')
  ) then
    raise exception 'Experiment settings access is required';
  end if;

  select *
  into config_record
  from public.device_config_state
  where project_id = experiment_record.project_id
  order by updated_at desc
  limit 1;
  if config_record.project_id is null
    or config_record.updated_at is distinct from expected_inventory_updated_at
    or config_record.config_hash is distinct from expected_config_hash then
    raise exception 'Controller configuration changed before the edit was saved';
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
  if spec_mode not in ('controlled', 'observation', 'calibration') then
    raise exception 'Experiment mode is invalid';
  end if;
  if jsonb_typeof(spec_assignments) <> 'array' then
    raise exception 'Assignments must be a list';
  end if;
  assignment_count := jsonb_array_length(spec_assignments);
  if assignment_count < 1 or assignment_count > 100 then
    raise exception 'Select 1-100 pots';
  end if;
  if assignment_count is distinct from (
    select count(distinct item->>'pairing_name')
    from jsonb_array_elements(spec_assignments) item
  ) then
    raise exception 'Each pairing can be selected only once';
  end if;

  if nullif(reviewed_spec->>'start_date', '') is not null then
    begin
      spec_start_at := (reviewed_spec->>'start_date')::timestamptz;
    exception when others then
      raise exception 'Start date is invalid';
    end;
  end if;

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

  select coalesce(max(version), 0) + 1
  into next_version
  from public.experiment_revisions revision
  where revision.experiment_id = experiment_record.id;

  insert into public.experiment_revisions (
    id, experiment_id, project_id, version, source, spec,
    inventory_updated_at, inventory_hash, model_name, prompt_fingerprint, created_by
  ) values (
    created_revision_id, experiment_record.id, experiment_record.project_id,
    next_version, revision_source, reviewed_spec, config_record.updated_at,
    config_record.config_hash, revision_model_name, revision_prompt_fingerprint,
    requested_actor_id
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

    select pot.id
    into selected_pot_id
    from public.research_sites site
    join public.research_pots pot
      on pot.site_id = site.id
     and pot.project_id = site.project_id
     and pot.pot_number = zone_match[2]::integer
    where site.project_id = experiment_record.project_id
      and site.slug = 'primary'
    limit 1;

    insert into public.experiment_assignments (
      revision_id, experiment_id, project_id, pot_id, pairing_name, zone, pot_number,
      crop, treatment, block, substrate, target_vwc_percent,
      measurement_interval_minutes, notes, sensor_key_snapshot,
      valve_key_snapshot, calibration_name_snapshot, source_target_vwc_percent,
      source_valve_open_time_ms, source_measurement_interval_ms
    ) values (
      created_revision_id, experiment_record.id, experiment_record.project_id,
      selected_pot_id, assignment_name, zone_match[1]::integer, zone_match[2]::integer,
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
  set name = spec_name,
      description = spec_description,
      mode = spec_mode,
      started_at = coalesce(spec_start_at, started_at),
      current_revision_id = created_revision_id,
      updated_at = now()
  where id = experiment_record.id;

  insert into public.experiment_audit_events (
    experiment_id, project_id, revision_id, event_type, actor_id, details
  ) values (
    experiment_record.id, experiment_record.project_id, created_revision_id,
    'revision_created', requested_actor_id,
    jsonb_build_object(
      'previous_revision_id', expected_revision_id,
      'version', next_version,
      'source', revision_source,
      'assignment_count', assignment_count,
      'config_hash', expected_config_hash
    )
  );

  select attached.plan_id, attached.batch_id
  into created_plan
  from public.attach_experiment_control_plan(
    experiment_record.id,
    requested_actor_id,
    reviewed_spec,
    compiled_plan,
    expected_inventory_updated_at,
    expected_config_hash
  ) attached;

  return query
  select experiment_record.id, experiment_record.slug, created_revision_id,
    next_version, created_plan.plan_id, created_plan.batch_id;
end;
$$;

revoke all on function public.revise_and_attach_experiment(
  uuid, uuid, uuid, jsonb, jsonb, timestamptz, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.revise_and_attach_experiment(
  uuid, uuid, uuid, jsonb, jsonb, timestamptz, text, text, text, text
) to service_role;

comment on function public.revise_and_attach_experiment(
  uuid, uuid, uuid, jsonb, jsonb, timestamptz, text, text, text, text
) is
  'Creates an immutable experiment revision and its reviewed fail-closed controller plan in one transaction.';

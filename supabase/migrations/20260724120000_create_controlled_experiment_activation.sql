-- Guarded V2 experiment activation.
--
-- The model never writes controller commands. A reviewed experiment is
-- compiled into a typed, dependency-ordered command batch. The controller
-- executor may claim a step only after its prerequisite succeeds. A failure
-- cancels all dependent steps and leaves the controller stopped.

alter table public.experiments
  drop constraint if exists experiments_status_check;
alter table public.experiments
  add constraint experiments_status_check
  check (
    status in (
      'published_sensing',
      'activating',
      'active',
      'activation_failed',
      'completed',
      'archived'
    )
  );

alter table public.experiment_audit_events
  drop constraint if exists experiment_audit_events_event_type_check;
alter table public.experiment_audit_events
  add constraint experiment_audit_events_event_type_check
  check (
    event_type in (
      'legacy_imported',
      'published_sensing',
      'activation_requested',
      'activation_succeeded',
      'activation_failed',
      'archived'
    )
  );

alter table public.experiment_assignments
  drop constraint if exists experiment_assignments_measurement_interval_minutes_check;
alter table public.experiment_assignments
  add constraint experiment_assignments_measurement_interval_minutes_check
  check (
    measurement_interval_minutes is null
    or measurement_interval_minutes between 0.5 and 1440
  );

create table if not exists public.experiment_control_plans (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.experiments(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  batch_id uuid not null unique default gen_random_uuid(),
  status text not null default 'prepared'
    check (status in ('prepared', 'queued', 'executing', 'active', 'failed')),
  expected_step_count integer not null check (expected_step_count between 0 and 60),
  expected_inventory_updated_at timestamptz not null,
  expected_config_hash text not null,
  final_watering_state text not null check (final_watering_state in ('off', 'controller_managed')),
  created_by uuid not null references auth.users(id),
  confirmed_at timestamptz not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (experiment_id, id),
  unique (id, project_id)
);

create table if not exists public.experiment_control_plan_steps (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.experiment_control_plans(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  sequence integer not null check (sequence between 1 and 60),
  label text not null check (char_length(label) between 1 and 160),
  command_type text not null check (
    command_type in ('update_system_state', 'bulk_update_pairings')
  ),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  confirm boolean not null default false,
  client_request_id uuid not null unique,
  command_id uuid unique,
  created_at timestamptz not null default now(),
  unique (plan_id, sequence)
);

alter table public.project_control_commands
  add column if not exists depends_on_command_id uuid,
  add column if not exists batch_id uuid,
  add column if not exists experiment_id uuid;

alter table public.project_control_commands
  drop constraint if exists project_control_commands_dependency_fk;
alter table public.project_control_commands
  add constraint project_control_commands_dependency_fk
  foreign key (depends_on_command_id)
  references public.project_control_commands(id)
  on delete set null;

alter table public.project_control_commands
  drop constraint if exists project_control_commands_experiment_fk;
alter table public.project_control_commands
  add constraint project_control_commands_experiment_fk
  foreign key (experiment_id)
  references public.experiments(id)
  on delete set null;

alter table public.experiment_control_plan_steps
  drop constraint if exists experiment_control_plan_steps_command_fk;
alter table public.experiment_control_plan_steps
  add constraint experiment_control_plan_steps_command_fk
  foreign key (command_id)
  references public.project_control_commands(id)
  on delete set null;

create index if not exists project_control_commands_dependency_idx
  on public.project_control_commands (depends_on_command_id)
  where depends_on_command_id is not null;
create index if not exists project_control_commands_batch_idx
  on public.project_control_commands (batch_id, requested_at)
  where batch_id is not null;
create index if not exists experiment_control_plans_project_idx
  on public.experiment_control_plans (project_id, created_at desc);
create index if not exists experiment_control_plan_steps_plan_idx
  on public.experiment_control_plan_steps (plan_id, sequence);

alter table public.experiment_control_plans enable row level security;
alter table public.experiment_control_plan_steps enable row level security;

revoke all on public.experiment_control_plans from public, anon, authenticated;
revoke all on public.experiment_control_plan_steps from public, anon, authenticated;
grant select on public.experiment_control_plans to authenticated, service_role;
grant select on public.experiment_control_plan_steps to authenticated, service_role;
grant insert, update, delete on public.experiment_control_plans to service_role;
grant insert, update, delete on public.experiment_control_plan_steps to service_role;

drop policy if exists "portal members read visible control plans"
  on public.experiment_control_plans;
create policy "portal members read visible control plans"
  on public.experiment_control_plans
  for select to authenticated
  using (
    public.has_portal_access(project_id)
    and
    exists (
      select 1
      from public.experiments experiment
      where experiment.id = experiment_control_plans.experiment_id
        and experiment.project_id = experiment_control_plans.project_id
    )
  );

drop policy if exists "portal members read visible control plan steps"
  on public.experiment_control_plan_steps;
create policy "portal members read visible control plan steps"
  on public.experiment_control_plan_steps
  for select to authenticated
  using (
    public.has_portal_access(project_id)
    and
    exists (
      select 1
      from public.experiment_control_plans plan
      join public.experiments experiment on experiment.id = plan.experiment_id
      where plan.id = experiment_control_plan_steps.plan_id
        and plan.project_id = experiment_control_plan_steps.project_id
    )
  );

-- Patch the established device claim function narrowly: a dependent command
-- remains invisible until its prerequisite succeeded.
do $$
declare
  definition text;
  original_fragment text :=
    E'    and pcc.expires_at > now()\n  order by pcc.requested_at asc';
  guarded_fragment text :=
    E'    and pcc.expires_at > now()\n'
    || E'    and (\n'
    || E'      pcc.depends_on_command_id is null\n'
    || E'      or exists (\n'
    || E'        select 1\n'
    || E'        from public.project_control_commands prerequisite\n'
    || E'        where prerequisite.id = pcc.depends_on_command_id\n'
    || E'          and prerequisite.project_id = pcc.project_id\n'
    || E'          and prerequisite.device_id = pcc.device_id\n'
    || E'          and prerequisite.status = ''succeeded''\n'
    || E'      )\n'
    || E'    )\n'
    || E'  order by pcc.requested_at asc';
begin
  select pg_get_functiondef(
    'public.device_claim_control_command(text,text)'::regprocedure
  ) into definition;

  if position('pcc.depends_on_command_id is null' in definition) > 0 then
    return;
  end if;
  if position(original_fragment in definition) = 0 then
    raise exception 'Could not locate the guarded claim insertion point';
  end if;

  definition := replace(definition, original_fragment, guarded_fragment);
  execute definition;
end;
$$;

create or replace function public.reconcile_experiment_control_plan(
  requested_plan_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  plan_record public.experiment_control_plans%rowtype;
  linked_count integer;
  succeeded_count integer;
  failed_count integer;
  running_count integer;
  queued_count integer;
  next_status text;
  previous_status text;
begin
  select *
  into plan_record
  from public.experiment_control_plans
  where id = requested_plan_id
  for update;

  if plan_record.id is null then
    return;
  end if;

  select
    count(step.command_id),
    count(step.command_id) filter (where command.status = 'succeeded'),
    count(step.command_id) filter (
      where command.status in ('failed', 'canceled', 'expired')
    ),
    count(step.command_id) filter (where command.status = 'running'),
    count(step.command_id) filter (where command.status in ('queued', 'accepted'))
  into linked_count, succeeded_count, failed_count, running_count, queued_count
  from public.experiment_control_plan_steps step
  left join public.project_control_commands command on command.id = step.command_id
  where step.plan_id = requested_plan_id;

  if plan_record.expected_step_count = 0 then
    next_status := 'active';
  elsif failed_count > 0 then
    next_status := 'failed';
  elsif linked_count = plan_record.expected_step_count
    and succeeded_count = plan_record.expected_step_count then
    next_status := 'active';
  elsif running_count > 0 then
    next_status := 'executing';
  elsif queued_count > 0 or linked_count > 0 then
    next_status := 'queued';
  else
    next_status := 'prepared';
  end if;

  previous_status := plan_record.status;
  update public.experiment_control_plans
  set status = next_status,
      updated_at = now(),
      error = case
        when next_status = 'failed' and error is null
          then 'A controller command failed or was canceled'
        else error
      end
  where id = requested_plan_id;

  if next_status = 'active' then
    update public.experiments
    set status = 'active',
        watering_state = plan_record.final_watering_state,
        updated_at = now()
    where id = plan_record.experiment_id;

    if previous_status <> 'active' then
      insert into public.experiment_audit_events (
        experiment_id, project_id, event_type, actor_id, details
      ) values (
        plan_record.experiment_id,
        plan_record.project_id,
        'activation_succeeded',
        plan_record.created_by,
        jsonb_build_object('plan_id', plan_record.id, 'batch_id', plan_record.batch_id)
      );
    end if;
  elsif next_status = 'failed' then
    update public.experiments
    set status = 'activation_failed',
        watering_state = 'off',
        updated_at = now()
    where id = plan_record.experiment_id;

    if previous_status <> 'failed' then
      insert into public.experiment_audit_events (
        experiment_id, project_id, event_type, actor_id, details
      ) values (
        plan_record.experiment_id,
        plan_record.project_id,
        'activation_failed',
        plan_record.created_by,
        jsonb_build_object('plan_id', plan_record.id, 'batch_id', plan_record.batch_id)
      );
    end if;
  end if;
end;
$$;

revoke all on function public.reconcile_experiment_control_plan(uuid)
  from public, anon, authenticated;
grant execute on function public.reconcile_experiment_control_plan(uuid)
  to service_role;

create or replace function public.reconcile_experiment_control_command()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected_plan_id uuid;
begin
  if new.status in ('failed', 'canceled', 'expired')
    and old.status is distinct from new.status then
    update public.project_control_commands dependent
    set status = 'canceled',
        completed_at = now(),
        lease_expires_at = null,
        error = 'Canceled because a prerequisite command did not succeed'
    where dependent.depends_on_command_id = new.id
      and dependent.status in ('queued', 'accepted');
  end if;

  select step.plan_id
  into affected_plan_id
  from public.experiment_control_plan_steps step
  where step.command_id = new.id
  limit 1;

  if affected_plan_id is not null then
    perform public.reconcile_experiment_control_plan(affected_plan_id);
  end if;
  return new;
end;
$$;

drop trigger if exists reconcile_experiment_control_command_trigger
  on public.project_control_commands;
create trigger reconcile_experiment_control_command_trigger
after update of status on public.project_control_commands
for each row
when (old.status is distinct from new.status)
execute function public.reconcile_experiment_control_command();

create or replace function public.enqueue_portal_control_command_v2(
  command_project_id uuid,
  command_device_id text,
  command_type text,
  command_payload jsonb,
  command_requested_by uuid,
  command_expires_at timestamptz,
  command_requires_confirmation boolean,
  command_confirmed_at timestamptz,
  command_client_request_id uuid,
  command_depends_on_id uuid default null,
  command_batch_id uuid default null,
  command_experiment_id uuid default null
)
returns setof public.project_control_commands
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  queued_command public.project_control_commands%rowtype;
  plan_record public.experiment_control_plans%rowtype;
  step_record public.experiment_control_plan_steps%rowtype;
  previous_command_id uuid;
  requested_command_type text := command_type;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may enqueue portal control commands';
  end if;

  if command_batch_id is not null or command_experiment_id is not null
    or command_depends_on_id is not null then
    if command_batch_id is null or command_experiment_id is null then
      raise exception 'Experiment command metadata is incomplete';
    end if;

    select *
    into plan_record
    from public.experiment_control_plans
    where batch_id = command_batch_id
      and experiment_id = command_experiment_id
      and project_id = command_project_id
      and created_by = command_requested_by
    for update;
    if plan_record.id is null then
      raise exception 'Experiment control plan is unavailable';
    end if;

    select planned_step.*
    into step_record
    from public.experiment_control_plan_steps planned_step
    where planned_step.plan_id = plan_record.id
      and planned_step.client_request_id = command_client_request_id
      and planned_step.command_type = requested_command_type
      and planned_step.payload = command_payload
    for update;
    if step_record.id is null then
      raise exception 'Controller command does not match the reviewed plan';
    end if;

    if step_record.sequence > 1 then
      select previous_step.command_id
      into previous_command_id
      from public.experiment_control_plan_steps previous_step
      where previous_step.plan_id = plan_record.id
        and previous_step.sequence = step_record.sequence - 1;
      if previous_command_id is null
        or previous_command_id is distinct from command_depends_on_id then
        raise exception 'Controller command dependency does not match the reviewed plan';
      end if;
    elsif command_depends_on_id is not null then
      raise exception 'The first controller command cannot have a dependency';
    end if;
  end if;

  select *
  into queued_command
  from public.enqueue_portal_control_command(
    command_project_id,
    command_device_id,
    command_type,
    command_payload,
    command_requested_by,
    command_expires_at,
    command_requires_confirmation,
    command_confirmed_at,
    command_client_request_id
  )
  limit 1;

  if command_batch_id is not null then
    if queued_command.batch_id is not null
      and (
        queued_command.batch_id is distinct from command_batch_id
        or queued_command.experiment_id is distinct from command_experiment_id
        or queued_command.depends_on_command_id is distinct from command_depends_on_id
      ) then
      raise exception 'Existing command metadata does not match the reviewed plan';
    end if;

    update public.project_control_commands
    set depends_on_command_id = command_depends_on_id,
        batch_id = command_batch_id,
        experiment_id = command_experiment_id
    where id = queued_command.id
    returning * into queued_command;

    update public.experiment_control_plan_steps
    set command_id = queued_command.id
    where id = step_record.id
      and (command_id is null or command_id = queued_command.id);
    if not found then
      raise exception 'Controller command step is already linked to another command';
    end if;

    perform public.reconcile_experiment_control_plan(plan_record.id);
  end if;

  return next queued_command;
end;
$$;

revoke all on function public.enqueue_portal_control_command_v2(
  uuid, text, text, jsonb, uuid, timestamptz, boolean, timestamptz, uuid,
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.enqueue_portal_control_command_v2(
  uuid, text, text, jsonb, uuid, timestamptz, boolean, timestamptz, uuid,
  uuid, uuid, uuid
) to service_role;

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
    and created_by = requested_actor_id
    and status = 'published_sensing'
    and watering_state = 'off'
  for update;
  if experiment_record.id is null then
    raise exception 'The new experiment is not available for activation';
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

create or replace function public.mark_experiment_activation_enqueue_failed(
  requested_plan_id uuid,
  failure_message text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  plan_record public.experiment_control_plans%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may mark activation failure';
  end if;
  select * into plan_record
  from public.experiment_control_plans
  where id = requested_plan_id
  for update;
  if plan_record.id is null then
    return;
  end if;

  update public.experiment_control_plans
  set status = 'failed',
      error = left(coalesce(failure_message, 'Controller command enqueue failed'), 500),
      updated_at = now()
  where id = requested_plan_id;
  update public.experiments
  set status = 'activation_failed',
      watering_state = 'off',
      updated_at = now()
  where id = plan_record.experiment_id;
end;
$$;

revoke all on function public.mark_experiment_activation_enqueue_failed(uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_experiment_activation_enqueue_failed(uuid, text)
  to service_role;

comment on table public.experiment_control_plans is
  'Reviewed controller activation plans compiled from immutable experiment specifications.';
comment on column public.project_control_commands.depends_on_command_id is
  'Prevents claim until the prerequisite command succeeds; failure cancels the chain.';

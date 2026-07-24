-- ExactH2O assistant operating layer.
--
-- Additive persistence, scheduling, monitoring, and lifecycle infrastructure.
-- This migration does not create an approved schedule, change an experiment,
-- queue a controller command, or modify any live controller configuration.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table if not exists public.assistant_threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'ExactH2O conversation'
    check (char_length(title) between 1 and 160),
  status text not null default 'active'
    check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id, user_id)
);

create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  project_id uuid not null,
  user_id uuid not null,
  request_id uuid references public.experiment_builder_requests(id) on delete set null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 8000),
  workflow text not null default 'answer'
    check (
      workflow in (
        'answer',
        'experiment',
        'settings',
        'archive',
        'schedule',
        'monitor',
        'lifecycle'
      )
    ),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (thread_id, project_id, user_id)
    references public.assistant_threads(id, project_id, user_id)
    on delete cascade
);

create unique index if not exists assistant_messages_request_role_unique
  on public.assistant_messages (thread_id, request_id, role)
  where request_id is not null;
create index if not exists assistant_threads_user_updated_idx
  on public.assistant_threads (project_id, user_id, updated_at desc);
create index if not exists assistant_messages_thread_created_idx
  on public.assistant_messages (thread_id, created_at asc);

create table if not exists public.assistant_schedules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_by_role text not null check (created_by_role in ('admin', 'researcher')),
  name text not null check (char_length(name) between 1 and 120),
  timezone text not null check (char_length(timezone) between 1 and 80),
  recurrence text not null check (recurrence in ('once', 'daily', 'weekly')),
  approved_plan jsonb not null check (jsonb_typeof(approved_plan) = 'object'),
  approved_config_hash text,
  review_token_hash text not null check (char_length(review_token_hash) = 64),
  status text not null default 'active'
    check (
      status in (
        'active',
        'running',
        'paused',
        'completed',
        'canceled',
        'failed'
      )
    ),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  lease_until timestamptz,
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, created_by, review_token_hash)
);

create table if not exists public.assistant_schedule_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.assistant_schedules(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  batch_id uuid,
  status text not null check (
    status in ('running', 'queued', 'succeeded', 'failed', 'skipped')
  ),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object'),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (schedule_id, started_at)
);

create index if not exists assistant_schedules_due_idx
  on public.assistant_schedules (next_run_at)
  where status = 'active' and next_run_at is not null;
create index if not exists assistant_schedules_user_idx
  on public.assistant_schedules (project_id, created_by, created_at desc);
create index if not exists assistant_schedule_runs_schedule_idx
  on public.assistant_schedule_runs (schedule_id, started_at desc);

create table if not exists public.assistant_monitors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  experiment_id uuid references public.experiments(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  metric text not null check (
    metric in ('current_vwc', 'change_vwc', 'sensor_stale', 'controller_health')
  ),
  comparator text not null check (
    comparator in ('above', 'below', 'increase_by', 'decrease_by', 'stale', 'unhealthy')
  ),
  threshold double precision
    check (threshold is null or threshold between 0 and 100),
  window_minutes integer not null check (window_minutes between 5 and 10080),
  pairing_names text[] not null default '{}',
  check_every_minutes integer not null check (check_every_minutes between 5 and 1440),
  cooldown_minutes integer not null check (cooldown_minutes between 5 and 10080),
  review_token_hash text not null check (char_length(review_token_hash) = 64),
  status text not null default 'active'
    check (status in ('active', 'paused', 'canceled')),
  last_state text not null default 'clear'
    check (last_state in ('clear', 'triggered', 'unknown')),
  last_evaluated_at timestamptz,
  last_triggered_at timestamptz,
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, created_by, review_token_hash)
);

create table if not exists public.assistant_monitor_events (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.assistant_monitors(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  state text not null check (state in ('triggered', 'resolved', 'unknown')),
  summary text not null check (char_length(summary) between 1 and 300),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  observed_at timestamptz not null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists assistant_monitors_due_idx
  on public.assistant_monitors (last_evaluated_at)
  where status = 'active';
create index if not exists assistant_monitors_user_idx
  on public.assistant_monitors (project_id, created_by, created_at desc);
create index if not exists assistant_monitor_events_project_idx
  on public.assistant_monitor_events (project_id, created_at desc);

alter table public.assistant_threads enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.assistant_schedules enable row level security;
alter table public.assistant_schedule_runs enable row level security;
alter table public.assistant_monitors enable row level security;
alter table public.assistant_monitor_events enable row level security;

revoke all on public.assistant_threads from public, anon, authenticated;
revoke all on public.assistant_messages from public, anon, authenticated;
revoke all on public.assistant_schedules from public, anon, authenticated;
revoke all on public.assistant_schedule_runs from public, anon, authenticated;
revoke all on public.assistant_monitors from public, anon, authenticated;
revoke all on public.assistant_monitor_events from public, anon, authenticated;

grant select on public.assistant_threads to authenticated, service_role;
grant select on public.assistant_messages to authenticated, service_role;
grant select on public.assistant_schedules to authenticated, service_role;
grant select on public.assistant_schedule_runs to authenticated, service_role;
grant select on public.assistant_monitors to authenticated, service_role;
grant select on public.assistant_monitor_events to authenticated, service_role;
grant insert, update, delete on public.assistant_threads to service_role;
grant insert, update, delete on public.assistant_messages to service_role;
grant insert, update, delete on public.assistant_schedules to service_role;
grant insert, update, delete on public.assistant_schedule_runs to service_role;
grant insert, update, delete on public.assistant_monitors to service_role;
grant insert, update, delete on public.assistant_monitor_events to service_role;

drop policy if exists "users read own assistant threads" on public.assistant_threads;
create policy "users read own assistant threads"
  on public.assistant_threads for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_portal_access(project_id)
  );

drop policy if exists "users read own assistant messages" on public.assistant_messages;
create policy "users read own assistant messages"
  on public.assistant_messages for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_portal_access(project_id)
  );

drop policy if exists "users read own schedules" on public.assistant_schedules;
create policy "users read own schedules"
  on public.assistant_schedules for select to authenticated
  using (
    public.has_portal_access(project_id)
    and (
      created_by = (select auth.uid())
      or public.current_portal_role(project_id) = 'admin'
    )
  );

drop policy if exists "users read own schedule runs" on public.assistant_schedule_runs;
create policy "users read own schedule runs"
  on public.assistant_schedule_runs for select to authenticated
  using (
    public.has_portal_access(project_id)
    and exists (
      select 1
      from public.assistant_schedules schedule
      where schedule.id = assistant_schedule_runs.schedule_id
        and (
          schedule.created_by = (select auth.uid())
          or public.current_portal_role(schedule.project_id) = 'admin'
        )
    )
  );

drop policy if exists "users read own monitors" on public.assistant_monitors;
create policy "users read own monitors"
  on public.assistant_monitors for select to authenticated
  using (
    public.has_portal_access(project_id)
    and (
      created_by = (select auth.uid())
      or public.current_portal_role(project_id) = 'admin'
    )
  );

drop policy if exists "users read own monitor events" on public.assistant_monitor_events;
create policy "users read own monitor events"
  on public.assistant_monitor_events for select to authenticated
  using (
    public.has_portal_access(project_id)
    and exists (
      select 1
      from public.assistant_monitors monitor
      where monitor.id = assistant_monitor_events.monitor_id
        and (
          monitor.created_by = (select auth.uid())
          or public.current_portal_role(monitor.project_id) = 'admin'
        )
    )
  );

create or replace function public.claim_due_assistant_schedules(claim_limit integer default 10)
returns setof public.assistant_schedules
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may claim assistant schedules';
  end if;

  return query
  with due as (
    select schedule.id
    from public.assistant_schedules schedule
    where schedule.status = 'active'
      and schedule.next_run_at is not null
      and schedule.next_run_at <= now()
      and (schedule.lease_until is null or schedule.lease_until <= now())
    order by schedule.next_run_at asc
    for update skip locked
    limit least(greatest(claim_limit, 1), 25)
  )
  update public.assistant_schedules schedule
  set status = 'running',
      lease_until = now() + interval '4 minutes',
      updated_at = now()
  from due
  where schedule.id = due.id
  returning schedule.*;
end;
$$;

revoke all on function public.claim_due_assistant_schedules(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_assistant_schedules(integer)
  to service_role;

create or replace function public.finish_assistant_schedule_run(
  requested_schedule_id uuid,
  run_status text,
  run_batch_id uuid default null,
  run_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  schedule public.assistant_schedules%rowtype;
  next_time timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may finish assistant schedules';
  end if;
  if run_status not in ('queued', 'succeeded', 'failed', 'skipped') then
    raise exception 'Invalid assistant schedule run status';
  end if;

  select * into schedule
  from public.assistant_schedules
  where id = requested_schedule_id
  for update;
  if schedule.id is null then
    return;
  end if;

  insert into public.assistant_schedule_runs (
    schedule_id,
    project_id,
    batch_id,
    status,
    details,
    started_at,
    completed_at
  ) values (
    schedule.id,
    schedule.project_id,
    run_batch_id,
    run_status,
    coalesce(run_details, '{}'::jsonb),
    coalesce(schedule.lease_until - interval '4 minutes', now()),
    now()
  );

  if run_status in ('queued', 'succeeded') then
    next_time := case schedule.recurrence
      when 'daily' then (
        (schedule.next_run_at at time zone schedule.timezone) + interval '1 day'
      ) at time zone schedule.timezone
      when 'weekly' then (
        (schedule.next_run_at at time zone schedule.timezone) + interval '7 days'
      ) at time zone schedule.timezone
      else null
    end;
    while next_time is not null and next_time <= now() loop
      next_time := case schedule.recurrence
        when 'daily' then (
          (next_time at time zone schedule.timezone) + interval '1 day'
        ) at time zone schedule.timezone
        when 'weekly' then (
          (next_time at time zone schedule.timezone) + interval '7 days'
        ) at time zone schedule.timezone
        else null
      end;
    end loop;
    update public.assistant_schedules
    set status = case when next_time is null then 'completed' else 'active' end,
        next_run_at = next_time,
        last_run_at = now(),
        last_error = null,
        lease_until = null,
        updated_at = now()
    where id = schedule.id;
  else
    update public.assistant_schedules
    set status = 'failed',
        last_run_at = now(),
        last_error = left(coalesce(run_details->>'error', 'Schedule did not run'), 500),
        lease_until = null,
        updated_at = now()
    where id = schedule.id;
  end if;
end;
$$;

revoke all on function public.finish_assistant_schedule_run(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.finish_assistant_schedule_run(uuid, text, uuid, jsonb)
  to service_role;

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
      'completed',
      'archived',
      'restored'
    )
  );

create or replace function public.complete_assistant_experiment(
  requested_project_id uuid,
  requested_experiment_id uuid
)
returns table (experiment_id uuid, experiment_slug text, experiment_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text;
  experiment public.experiments%rowtype;
begin
  select public.current_portal_role(requested_project_id) into caller_role;
  if caller_id is null or caller_role not in ('admin', 'researcher') then
    raise exception 'Researcher or administrator access is required';
  end if;

  select * into experiment
  from public.experiments
  where id = requested_experiment_id
    and project_id = requested_project_id
  for update;
  if experiment.id is null then raise exception 'Experiment not found'; end if;
  if experiment.watering_state <> 'off' then
    raise exception 'Turn watering off through a reviewed settings plan before completion';
  end if;
  if experiment.status not in ('published_sensing', 'active', 'activation_failed') then
    raise exception 'This experiment cannot be completed from its current state';
  end if;
  if exists (
    select 1
    from public.project_control_commands command
    where command.experiment_id = experiment.id
      and command.status in ('queued', 'accepted', 'running')
  ) then
    raise exception 'Wait for active experiment commands to finish';
  end if;

  update public.experiments
  set status = 'completed',
      ended_at = now(),
      updated_at = now()
  where id = experiment.id;

  insert into public.experiment_audit_events (
    experiment_id, project_id, revision_id, event_type, actor_id, details
  ) values (
    experiment.id,
    experiment.project_id,
    experiment.current_revision_id,
    'completed',
    caller_id,
    jsonb_build_object('source', 'portal_assistant')
  );

  return query select experiment.id, experiment.slug, 'completed'::text;
end;
$$;

revoke all on function public.complete_assistant_experiment(uuid, uuid)
  from public, anon;
grant execute on function public.complete_assistant_experiment(uuid, uuid)
  to authenticated, service_role;

create or replace function public.restore_assistant_experiment(
  requested_project_id uuid,
  requested_experiment_id uuid
)
returns table (experiment_id uuid, experiment_slug text, experiment_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  caller_role text;
  experiment public.experiments%rowtype;
  revision_source text;
begin
  select public.current_portal_role(requested_project_id) into caller_role;
  if caller_id is null or caller_role not in ('admin', 'researcher') then
    raise exception 'Researcher or administrator access is required';
  end if;

  select * into experiment
  from public.experiments
  where id = requested_experiment_id
    and project_id = requested_project_id
  for update;
  if experiment.id is null then raise exception 'Experiment not found'; end if;
  select source into revision_source
  from public.experiment_revisions
  where id = experiment.current_revision_id;

  if experiment.status <> 'archived' or experiment.watering_state <> 'off' then
    raise exception 'Only a safely archived sensing experiment can be restored';
  end if;
  if revision_source not in ('manual', 'natural_language') then
    raise exception 'Built-in experiments cannot be restored through the assistant';
  end if;
  if caller_role <> 'admin' and experiment.created_by is distinct from caller_id then
    raise exception 'Only the creator or an administrator can restore this experiment';
  end if;

  update public.experiments
  set status = 'published_sensing',
      ended_at = null,
      updated_at = now()
  where id = experiment.id;

  insert into public.experiment_audit_events (
    experiment_id, project_id, revision_id, event_type, actor_id, details
  ) values (
    experiment.id,
    experiment.project_id,
    experiment.current_revision_id,
    'restored',
    caller_id,
    jsonb_build_object('source', 'portal_assistant', 'watering_state', 'off')
  );

  return query select experiment.id, experiment.slug, 'published_sensing'::text;
end;
$$;

revoke all on function public.restore_assistant_experiment(uuid, uuid)
  from public, anon;
grant execute on function public.restore_assistant_experiment(uuid, uuid)
  to authenticated, service_role;

create or replace function public.invoke_assistant_automation_runner()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, vault, net
as $$
declare
  cron_secret text;
  request_id bigint;
begin
  select decrypted_secret
  into cron_secret
  from vault.decrypted_secrets
  where name = 'exacth2o_owner_health_cron_secret'
  limit 1;

  if char_length(coalesce(cron_secret, '')) < 32 then
    raise exception 'Assistant automation Cron secret is unavailable';
  end if;

  select net.http_post(
    url := 'https://zmhdclcjrkntrpynozvo.supabase.co/functions/v1/assistant-automation-runner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-assistant-automation-secret', cron_secret
    ),
    body := jsonb_build_object('source', 'supabase_cron'),
    timeout_milliseconds := 25000
  )
  into request_id;

  return request_id;
end;
$$;

revoke all on function public.invoke_assistant_automation_runner()
  from public, anon, authenticated;
grant execute on function public.invoke_assistant_automation_runner()
  to service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'exacth2o-assistant-automation';

select cron.schedule(
  'exacth2o-assistant-automation',
  '*/5 * * * *',
  'select public.invoke_assistant_automation_runner();'
);

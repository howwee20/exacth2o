-- ROLLBACK for 04_experiment_lifecycle_authorization.sql (review only): restores the baseline
-- definitions (supabase/baseline/20260724210000_public_schema.sql:564-618, 735-745, 4059-4113).
-- WARNING: this reintroduces the NULL-role bypass described in the forward migration.

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

create or replace function public.complete_assistant_experiment(
  requested_project_id uuid,
  requested_experiment_id uuid
)
returns table(experiment_id uuid, experiment_slug text, experiment_status text)
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

create or replace function public.restore_assistant_experiment(
  requested_project_id uuid,
  requested_experiment_id uuid
)
returns table(experiment_id uuid, experiment_slug text, experiment_status text)
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

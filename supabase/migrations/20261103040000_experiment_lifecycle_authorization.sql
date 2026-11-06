-- Cross-tenant authorization bypass. complete_assistant_experiment and
-- restore_assistant_experiment are SECURITY DEFINER and executable by every authenticated user
-- (baseline 8647-8649, 8896-8898). Their only gate is
--     if caller_id is null or caller_role not in ('admin', 'researcher') then raise ...
-- (baseline 574, 4070). For a caller with no portal_access row in the requested
-- project, current_portal_role() returns NULL, "NULL not in (...)" is NULL, the IF is not taken,
-- and the function goes on to complete/restore the experiment with owner privileges. In
-- restore, "caller_role <> 'admin' and ..." (baseline 4090) is NULL for the same caller, so
-- the creator check is skipped as well. Project viewers are correctly refused (non-NULL role);
-- outsiders are not.
--
-- Scope. current_portal_role ignores portal_access.access_scope, so gas-mixer-only
-- accounts (access_scope 'gas_mixer', role 'researcher') pass the same gate and the
-- experiment_builder_requests INSERT policy (baseline 8558).
--
-- Smallest compatible fix: make both gates NULL-safe and scope current_portal_role to project
-- access. Bodies are otherwise byte-for-byte the baseline bodies; signatures, owners and ACLs
-- are unchanged (CREATE OR REPLACE). The experiment-builder Edge Function already refuses
-- non-members before calling these RPCs, so legitimate flows are unaffected.

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
    and pa.access_scope = 'project'
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
  if caller_id is null or coalesce(caller_role, '') not in ('admin', 'researcher') then
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
  if caller_id is null or coalesce(caller_role, '') not in ('admin', 'researcher') then
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
  -- Unchanged from the baseline (a NULL source still passes here; optional hardening:
  -- coalesce(revision_source, '') to refuse experiments without a current revision).
  if revision_source not in ('manual', 'natural_language') then
    raise exception 'Built-in experiments cannot be restored through the assistant';
  end if;
  if caller_role is distinct from 'admin' and experiment.created_by is distinct from caller_id then
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

-- Residual (unchanged here to keep the change minimal): publish_sensing_experiment's inline
-- role lookup (baseline 2450-2456) also ignores access_scope; it already NULL-checks the role,
-- and the mixer project has no device_config_state row, so it is not reachable today.

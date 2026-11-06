-- Lease tokens are private capabilities. Only the claim/renew/save RPCs may use
-- them; project members can still inspect progress and request a stop.
begin;
set local lock_timeout = '5s';

lock table public.commissioning_sessions in access exclusive mode;

do $$
begin
  if exists (select 1 from public.commissioning_sessions where run_token is not null) then
    raise exception 'Finish or release commissioning runs before installing private lease access';
  end if;
end;
$$;

revoke select, insert, update on public.commissioning_sessions from authenticated;
grant select (
  id, project_id, device_id, run_id, created_by, operator_label, status, active,
  pot_count, original_snapshot, record, run_result, config_hash_at_start,
  heartbeat_at, stop_requested_at, stop_requested_by, started_at, updated_at, ended_at
) on public.commissioning_sessions to authenticated;
grant insert (
  project_id, device_id, run_id, operator_label, status, pot_count,
  original_snapshot, record, config_hash_at_start
) on public.commissioning_sessions to authenticated;
grant update (stop_requested_at) on public.commissioning_sessions to authenticated;

drop function public.claim_commissioning_run(uuid, text, text, uuid, integer);

create function public.claim_commissioning_run(
  claim_project_id uuid,
  claim_device_id text,
  claim_run_id text,
  claim_token uuid,
  stale_after_seconds integer default 180,
  lease_protocol integer default null
)
returns public.commissioning_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.commissioning_sessions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and public.has_portal_project_role(claim_project_id, array['admin', 'researcher']) is not true then
    raise exception 'Project operator access is required' using errcode = '42501';
  end if;
  if lease_protocol is distinct from 2 then
    raise exception 'Reload the portal before starting an autocalibration run';
  end if;
  if claim_token is null then
    raise exception 'A run token is required';
  end if;
  select * into session_row from public.commissioning_sessions
  where project_id = claim_project_id and device_id = claim_device_id and run_id = claim_run_id
  for update;
  if not found then
    raise exception 'Autocalibration session not found' using errcode = 'P0002';
  end if;
  if not session_row.active then
    raise exception 'This autocalibration session has ended';
  end if;
  if session_row.run_token is not null
     and session_row.run_token is distinct from claim_token
     and session_row.heartbeat_at is not null
     and session_row.heartbeat_at > now() - make_interval(secs => greatest(60, least(coalesce(stale_after_seconds, 180), 3600))) then
    raise exception 'Another screen is running this autocalibration session' using errcode = '55P03';
  end if;
  update public.commissioning_sessions
  set status = 'running', run_token = claim_token, heartbeat_at = now(), stop_requested_at = null
  where id = session_row.id
  returning * into session_row;
  return session_row;
end;
$$;

create or replace function public.renew_commissioning_run(
  renew_project_id uuid,
  renew_device_id text,
  renew_run_id text,
  renew_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.commissioning_sessions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and public.has_portal_project_role(renew_project_id, array['admin', 'researcher']) is not true then
    raise exception 'Project operator access is required' using errcode = '42501';
  end if;
  update public.commissioning_sessions
  set heartbeat_at = now()
  where project_id = renew_project_id and device_id = renew_device_id and run_id = renew_run_id
    and run_token = renew_token and active and status = 'running'
  returning * into session_row;
  if not found then
    raise exception 'This screen no longer holds the autocalibration run' using errcode = '55P03';
  end if;
  return jsonb_build_object(
    'stop_requested_at', session_row.stop_requested_at,
    'stop_requested_by', session_row.stop_requested_by,
    'heartbeat_at', session_row.heartbeat_at
  );
end;
$$;

-- A missing token permits ordinary edits between run segments. While a segment
-- has an owner, only that owner's private token permits checkpoints or release.
create or replace function public.save_commissioning_session(
  save_project_id uuid,
  save_device_id text,
  save_run_id text,
  save_patch jsonb,
  save_token uuid default null
)
returns public.commissioning_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.commissioning_sessions%rowtype;
  patched public.commissioning_sessions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and public.has_portal_project_role(save_project_id, array['admin', 'researcher']) is not true then
    raise exception 'Project operator access is required' using errcode = '42501';
  end if;
  if jsonb_typeof(save_patch) is distinct from 'object'
     or save_patch - array['status', 'active', 'record', 'run_result', 'operator_label', 'heartbeat_at', 'run_token'] <> '{}'::jsonb then
    raise exception 'Invalid autocalibration session patch';
  end if;
  if save_patch ? 'run_token' and save_patch->'run_token' <> 'null'::jsonb then
    raise exception 'Claim a run through claim_commissioning_run';
  end if;
  select * into session_row from public.commissioning_sessions
  where project_id = save_project_id and device_id = save_device_id and run_id = save_run_id
  for update;
  if not found then
    raise exception 'Autocalibration session not found' using errcode = 'P0002';
  end if;
  if save_token is distinct from session_row.run_token then
    if save_token is not null then
      return null;
    end if;
    if session_row.heartbeat_at is not null
       and session_row.heartbeat_at > now() - interval '180 seconds' then
      raise exception 'Another screen is running this autocalibration session' using errcode = '55P03';
    end if;
    -- A stopped responding screen may be restored/closed without a new run.
    -- Retire its capability atomically before applying the between-run edit.
    session_row.run_token := null;
    session_row.heartbeat_at := null;
    if session_row.status = 'running' then session_row.status := 'interrupted'; end if;
  end if;
  select * into patched from jsonb_populate_record(session_row, save_patch);
  -- A release always clears the heartbeat; a status change cannot leave a live
  -- capability on an ended segment, and a heartbeat cannot be cleared mid-run.
  if patched.run_token is null then
    patched.heartbeat_at := null;
  elsif patched.status <> 'running' or not patched.active or patched.heartbeat_at is null then
    raise exception 'Release the run token when finishing an autocalibration segment';
  end if;
  update public.commissioning_sessions
  set status = patched.status, active = patched.active, record = patched.record,
      run_result = patched.run_result, operator_label = patched.operator_label,
      heartbeat_at = patched.heartbeat_at, run_token = patched.run_token
  where id = session_row.id
  returning * into session_row;
  return session_row;
end;
$$;

revoke all on function public.claim_commissioning_run(uuid, text, text, uuid, integer, integer) from public, anon;
revoke all on function public.renew_commissioning_run(uuid, text, text, uuid) from public, anon;
revoke all on function public.save_commissioning_session(uuid, text, text, jsonb, uuid) from public, anon;
grant execute on function public.claim_commissioning_run(uuid, text, text, uuid, integer, integer) to authenticated, service_role;
grant execute on function public.renew_commissioning_run(uuid, text, text, uuid) to authenticated, service_role;
grant execute on function public.save_commissioning_session(uuid, text, text, jsonb, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;

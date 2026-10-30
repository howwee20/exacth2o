-- claim_commissioning_run (SECURITY INVOKER) refuses to hand a running
-- autocalibration session to a different screen token while the holder's heartbeat is fresh
-- (supabase/migrations/20261021160000_full_scale_autocalibration_and_manual_hold.sql:341-380).
-- But authenticated also holds table-level UPDATE on commissioning_sessions and the UPDATE
-- policy admits any project admin/researcher (same file :269-291), so a direct PostgREST
-- PATCH can set run_token/status and take a live run without the freshness check; the
-- protect_commissioning_session trigger (:295-332) does not look at run_token.
--
-- Smallest compatible fix: the trigger enforces the claim function's own minimum staleness
-- (stale_after_seconds is clamped to >= 60 s) for any change to a different non-null token.
-- Unchanged: claims allowed by claim_commissioning_run, releasing a token (set to null),
-- stop requests, saves that do not touch run_token, and all other columns.

create or replace function public.protect_commissioning_session()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.original_snapshot is distinct from old.original_snapshot then
    raise exception 'The recorded original settings of a commissioning session cannot be changed';
  end if;
  if new.project_id is distinct from old.project_id or new.device_id is distinct from old.device_id
    or new.run_id is distinct from old.run_id or new.created_by is distinct from old.created_by then
    raise exception 'A commissioning session cannot move to another run, project, controller or owner';
  end if;
  if not old.active and new.active then
    raise exception 'A finished commissioning session cannot become active again';
  end if;
  -- A live run segment belongs to the screen holding run_token. Another token can take it
  -- only after the holder's heartbeat is at least as stale as claim_commissioning_run's
  -- smallest threshold (60 s); releasing the token (null) is always allowed.
  if new.run_token is not null
     and new.run_token is distinct from old.run_token
     and old.run_token is not null
     and old.active
     and old.status = 'running'
     and old.heartbeat_at is not null
     and old.heartbeat_at > now() - interval '60 seconds' then
    raise exception 'Another screen is running this autocalibration session' using errcode = '55P03';
  end if;
  -- Times come from the database clock, never from a browser.
  if new.heartbeat_at is distinct from old.heartbeat_at and new.heartbeat_at is not null then
    new.heartbeat_at := now();
  end if;
  if new.stop_requested_at is distinct from old.stop_requested_at then
    if new.stop_requested_at is null then
      new.stop_requested_by := null;
    else
      new.stop_requested_at := now();
      new.stop_requested_by := (select auth.uid());
    end if;
  end if;
  new.updated_at := now();
  if not new.active and new.ended_at is null then new.ended_at := now(); end if;
  return new;
end;
$$;

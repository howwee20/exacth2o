-- ROLLBACK for 02_commissioning_run_lease_guard.sql (review only): restores the trigger
-- function exactly as defined in
-- supabase/migrations/20261021160000_full_scale_autocalibration_and_manual_hold.sql:295-327.
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

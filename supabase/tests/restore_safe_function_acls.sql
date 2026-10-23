-- Wire into scripts/verify-database-baseline.sh after the existing psql -f lines, e.g.
--   psql "$db_url" -v ON_ERROR_STOP=1 -f "$repo_root/supabase/tests/security_definer_acl_snapshot.sql" >/dev/null
--
-- Purpose: the disposable restore (baseline + newer migrations on a stock local Supabase)
-- must expose exactly the reviewed SECURITY DEFINER surface. Without 20261022090004_restore_safe_function_acls this test fails in
-- the restore because anon/authenticated inherit EXECUTE from stock default privileges
-- (47 baseline functions; 4 of them have no internal role check). It assumes fixes 01 and 03
-- (03 removes PUBLIC/anon EXECUTE from is_project_member and the staff-name helpers).
-- New SECURITY DEFINER RPCs must be added to the allowlists deliberately.
-- Runs in one transaction and rolls back.
begin;

do $$
declare
  -- Token-authenticated controller RPCs are the only SECURITY DEFINER entry points for anon.
  anon_allowed text[] := array[
    'device_claim_control_command(text, text)',
    'device_complete_control_command(text, uuid, text, jsonb, text)',
    'device_ingest(text, jsonb)',
    'device_quarantine_control_command(text, uuid, text)',
    'device_renew_control_command_lease(text, uuid)',
    'device_report_control_executor_status(text, text, boolean, boolean, boolean, boolean, text, text)'
  ];
  -- Reviewed signed-in surface (each body checks auth.uid() / membership / token itself).
  authenticated_allowed text[] := anon_allowed || array[
    'chamber_schedule_delete(uuid, integer)',
    'chamber_schedule_overview()',
    'chamber_schedule_pause(uuid)',
    'chamber_schedule_resume(uuid, integer)',
    'chamber_schedule_save(uuid, jsonb)',
    'complete_assistant_experiment(uuid, uuid)',
    'confirm_autocalibration_delivery(uuid, text, text, text[], text)',
    'current_portal_role(uuid)',
    'delete_quote_request(uuid, uuid)',
    'edge_usage_budget()',
    'gas_mixer_native_status(uuid, text)',
    'gas_mixer_remote_status(uuid, text)',
    'has_gas_mixer_module_access(uuid, text, text)',
    'has_gas_mixer_native_access(uuid, text, text)',
    'has_portal_access(uuid)',
    'has_portal_project_role(uuid, text[])',
    'has_rd_system_admin_access(uuid)',
    'has_system_admin_installation_access(uuid, text, text)',
    'is_portal_admin(uuid)',
    'is_project_member(uuid)',
    'is_sales_support_staff(uuid)',
    'lighting_native_status(uuid, text)',
    'member_organization_ids()',
    'member_project_ids()',
    'portal_admin_project_ids()',
    'portal_project_ids()',
    'portal_team_snapshot(uuid)',
    'publish_sensing_experiment(uuid, jsonb, timestamp with time zone, text, text, text)',
    'reconcile_autocalibration_bindings(uuid, text, text, jsonb)',
    'restore_assistant_experiment(uuid, uuid)',
    'set_notification_preference(uuid, text, boolean, text, text[])',
    'walker_latest_recorded_snapshot(uuid, text, integer, integer)',
    'walker_live_observation_snapshot(uuid, text, integer, integer)',
    'walker_live_observation_status(uuid, text)',
    'walker_observation_overview(uuid, text)',
    'walker_observation_trace_page(uuid, text, integer[], timestamp with time zone, timestamp with time zone, integer)'
  ];
  unexpected text;
begin
  select string_agg(signature, '; ' order by signature)
  into unexpected
  from (
    select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) exposed
  where signature <> all (anon_allowed);
  if unexpected is not null then
    raise exception 'anon can execute unreviewed SECURITY DEFINER functions: %', unexpected;
  end if;

  select string_agg(signature, '; ' order by signature)
  into unexpected
  from (
    select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) exposed
  where signature <> all (authenticated_allowed);
  if unexpected is not null then
    raise exception 'authenticated can execute unreviewed SECURITY DEFINER functions: %', unexpected;
  end if;

  if not has_function_privilege('service_role',
       'public.create_project_invite(text,uuid,text,timestamptz)', 'EXECUTE') then
    raise exception 'service_role lost create_project_invite';
  end if;
end;
$$;

-- Behaviour: API roles cannot mint invite tokens or trigger outbound Edge calls.
create schema acl_snapshot_test;
create function acl_snapshot_test.expect_denied(statement text) returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when insufficient_privilege then
    return;
  end;
  raise exception 'Expected an authorization denial: %', statement;
end;
$$;
grant usage on schema acl_snapshot_test to anon, authenticated;
grant execute on function acl_snapshot_test.expect_denied(text) to anon, authenticated;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.jwt.claim.role', 'anon', true);
set local role anon;
select acl_snapshot_test.expect_denied($q$select * from public.create_project_invite('acl-test@example.invalid', '22222222-2222-4222-8222-222222222222', 'owner', now() + interval '1 day')$q$);
select acl_snapshot_test.expect_denied($q$select public.invoke_owner_health_sync()$q$);
select acl_snapshot_test.expect_denied($q$select public.portal_role_for_email('acl-test@example.invalid')$q$);
reset role;

select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select acl_snapshot_test.expect_denied($q$select * from public.create_project_invite('acl-test@example.invalid', '22222222-2222-4222-8222-222222222222', 'owner', now() + interval '1 day')$q$);
select acl_snapshot_test.expect_denied($q$select public.invoke_assistant_automation_runner()$q$);
reset role;

rollback;

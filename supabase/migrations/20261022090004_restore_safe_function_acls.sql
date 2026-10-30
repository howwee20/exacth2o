-- supabase/baseline/20260724210000_public_schema.sql is a pg_dump of production.
-- pg_dump writes function ACLs relative to PostgreSQL's built-in default (owner + PUBLIC), so
-- for a service-role-only function it emits only "REVOKE ALL ... FROM PUBLIC; GRANT ... TO
-- service_role". Production's own default privileges for role postgres in schema public grant
-- nothing to anon/authenticated (baseline lines 9274-9291), but a stock Supabase project or a
-- local `supabase start` grants EXECUTE on every new public function to anon, authenticated and
-- service_role. A restore made the documented way (baseline first, then newer migrations;
-- supabase/baseline/README.md:8-10, scripts/verify-database-baseline.sh) therefore leaves the
-- functions below executable by anon and authenticated. Several have no internal role check,
-- most importantly create_project_invite, which returns a raw owner/admin invite token.
--
-- In production every REVOKE/GRANT below is a no-op (the ACLs already match). It changes no row,
-- no function body other than create_project_invite, and no controller setting.

-- 1. Service-role-only functions (production ACL per baseline: postgres + service_role).
revoke all on function public.acquire_device_ingest_lease(uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.acquire_device_ingest_lease(uuid, text, uuid, integer) to service_role;
revoke all on function public.attach_experiment_control_plan(uuid, uuid, jsonb, jsonb, timestamp with time zone, text) from public, anon, authenticated;
grant execute on function public.attach_experiment_control_plan(uuid, uuid, jsonb, jsonb, timestamp with time zone, text) to service_role;
revoke all on function public.check_public_submission(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_public_submission(text, text, integer, integer) to service_role;
revoke all on function public.claim_due_assistant_schedules(integer) from public, anon, authenticated;
grant execute on function public.claim_due_assistant_schedules(integer) to service_role;
revoke all on function public.claim_rd_jobs(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_rd_jobs(text, integer, integer) to service_role;
revoke all on function public.claim_rd_jobs_v3(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_rd_jobs_v3(text, text, integer, integer) to service_role;
revoke all on function public.create_device_control_token(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_device_control_token(uuid, text, text) to service_role;
revoke all on function public.create_project_invite(text, uuid, text, timestamp with time zone) from public, anon, authenticated;
grant execute on function public.create_project_invite(text, uuid, text, timestamp with time zone) to service_role;
revoke all on function public.enqueue_portal_control_command(uuid, text, text, jsonb, uuid, timestamp with time zone, boolean, timestamp with time zone, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_portal_control_command(uuid, text, text, jsonb, uuid, timestamp with time zone, boolean, timestamp with time zone, uuid) to service_role;
revoke all on function public.enqueue_portal_control_command_batch(uuid, text, uuid, uuid, timestamp with time zone, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_portal_control_command_batch(uuid, text, uuid, uuid, timestamp with time zone, text, text, jsonb) to service_role;
revoke all on function public.enqueue_portal_control_command_v2(uuid, text, text, jsonb, uuid, timestamp with time zone, boolean, timestamp with time zone, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_portal_control_command_v2(uuid, text, text, jsonb, uuid, timestamp with time zone, boolean, timestamp with time zone, uuid, uuid, uuid, uuid) to service_role;
revoke all on function public.finish_assistant_schedule_run(uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.finish_assistant_schedule_run(uuid, text, uuid, jsonb) to service_role;
revoke all on function public.invoke_assistant_automation_runner() from public, anon, authenticated;
grant execute on function public.invoke_assistant_automation_runner() to service_role;
revoke all on function public.invoke_owner_health_sync() from public, anon, authenticated;
grant execute on function public.invoke_owner_health_sync() to service_role;
revoke all on function public.mark_experiment_activation_enqueue_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_experiment_activation_enqueue_failed(uuid, text) to service_role;
revoke all on function public.mirror_live_sensor_readings(jsonb) from public, anon, authenticated;
grant execute on function public.mirror_live_sensor_readings(jsonb) to service_role;
revoke all on function public.promote_rd_model(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.promote_rd_model(uuid, uuid, jsonb) to service_role;
revoke all on function public.prune_device_health_history(integer) from public, anon, authenticated;
grant execute on function public.prune_device_health_history(integer) to service_role;
revoke all on function "public"."rd_atomic_event_observation_v4"(uuid) from public, anon, authenticated;
grant execute on function "public"."rd_atomic_event_observation_v4"(uuid) to service_role;
revoke all on function public.rd_episode_observation_v3(uuid) from public, anon, authenticated;
grant execute on function public.rd_episode_observation_v3(uuid) to service_role;
revoke all on function public.rd_promote_model_v2(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rd_promote_model_v2(uuid, uuid, jsonb) to service_role;
revoke all on function public.rd_promote_v5_shadow_candidate(uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rd_promote_v5_shadow_candidate(uuid, text, uuid, jsonb) to service_role;
revoke all on function public.rd_publish_provisional_model_v4(text, text, text, text, integer, integer, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.rd_publish_provisional_model_v4(text, text, text, text, integer, integer, jsonb, jsonb, text) to service_role;
revoke all on function public.rd_publish_v5_challenger(text, text, text, text, integer, integer, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.rd_publish_v5_challenger(text, text, text, text, integer, integer, jsonb, jsonb, jsonb, text) to service_role;
revoke all on function public.rd_record_irrigation_event_v2(uuid, text, text, text, timestamp with time zone, integer, text, text, text, uuid, integer, double precision, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.rd_record_irrigation_event_v2(uuid, text, text, text, timestamp with time zone, integer, text, text, text, uuid, integer, double precision, text, jsonb, integer) to service_role;
revoke all on function public.rd_refresh_episode_states_v2(timestamp with time zone, integer) from public, anon, authenticated;
grant execute on function public.rd_refresh_episode_states_v2(timestamp with time zone, integer) to service_role;
revoke all on function public.rd_reject_and_advance_v5_shadow_candidate(uuid, text, uuid, timestamp with time zone, jsonb) from public, anon, authenticated;
grant execute on function public.rd_reject_and_advance_v5_shadow_candidate(uuid, text, uuid, timestamp with time zone, jsonb) to service_role;
revoke all on function public.rd_training_evidence_page_v4(text, timestamp with time zone, text, integer) from public, anon, authenticated;
grant execute on function public.rd_training_evidence_page_v4(text, timestamp with time zone, text, integer) to service_role;
revoke all on function public.rd_worker_observation(uuid, text, timestamp with time zone) from public, anon, authenticated;
grant execute on function public.rd_worker_observation(uuid, text, timestamp with time zone) to service_role;
revoke all on function public.rd_worker_predictions_v3(uuid, timestamp with time zone) from public, anon, authenticated;
grant execute on function public.rd_worker_predictions_v3(uuid, timestamp with time zone) to service_role;
revoke all on function public.reconcile_device_control_quarantine(uuid, text, timestamp with time zone, boolean, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.reconcile_device_control_quarantine(uuid, text, timestamp with time zone, boolean, jsonb, text, boolean) to service_role;
revoke all on function public.reconcile_experiment_control_plan(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_experiment_control_plan(uuid) to service_role;
revoke all on function public.release_device_ingest_lease(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.release_device_ingest_lease(uuid, text, uuid) to service_role;
revoke all on function public.run_device_health_retention(integer, integer) from public, anon, authenticated;
grant execute on function public.run_device_health_retention(integer, integer) to service_role;
revoke all on function public.save_public_quote_submission(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.save_public_quote_submission(jsonb, text, text) to service_role;
revoke all on function public.save_public_support_submission(jsonb, text) from public, anon, authenticated;
grant execute on function public.save_public_support_submission(jsonb, text) to service_role;

-- 2. Signed-in helpers/RPCs (production ACL per baseline: authenticated [+ service_role], never anon).
revoke all on function public.complete_assistant_experiment(uuid, uuid) from public, anon;
revoke all on function public.current_portal_role(uuid) from public, anon;
revoke all on function public.has_portal_access(uuid) from public, anon;
revoke all on function public.has_rd_system_admin_access(uuid) from public, anon;
revoke all on function public.is_portal_admin(uuid) from public, anon;
revoke all on function public.member_organization_ids() from public, anon;
revoke all on function public.member_project_ids() from public, anon;
revoke all on function public.portal_admin_project_ids() from public, anon;
revoke all on function public.portal_project_ids() from public, anon;
revoke all on function public.publish_sensing_experiment(uuid, jsonb, timestamp with time zone, text, text, text) from public, anon;
revoke all on function public.restore_assistant_experiment(uuid, uuid) from public, anon;

-- 3. Internal role-mapping helpers (production ACL per baseline: owner only).
revoke all on function public.portal_role_for_invite(text) from public, anon, authenticated;
revoke all on function public.project_member_role_for_invite(text) from public, anon, authenticated;

-- 4. Defense in depth: create_project_invite itself refuses every API caller except
--    service_role. Operator SQL (session_user postgres/supabase_admin) and
--    create_gas_mixer_invite (called with the service_role JWT) keep working.
--    Signature, defaults, return type, language, owner and ACL are unchanged.
create or replace function public.create_project_invite(
  invitee_email text,
  invited_project_id uuid default '22222222-2222-4222-8222-222222222222'::uuid,
  invite_role text default 'member',
  invite_expires_at timestamptz default now() + interval '14 days'
)
returns table (
  invite_id uuid,
  email text,
  project_id uuid,
  role text,
  invite_url text,
  raw_token text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  clean_email text := lower(trim(invitee_email));
  generated_token text := encode(gen_random_bytes(32), 'hex');
  inserted_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Only service_role may create project invites' using errcode = '42501';
  end if;

  if clean_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Invalid invite email';
  end if;

  if invite_role not in ('owner', 'admin', 'member', 'viewer') then
    raise exception 'Invalid invite role';
  end if;

  if invite_expires_at <= now() then
    raise exception 'Invite expiry must be in the future';
  end if;

  insert into public.project_invites (
    token_hash,
    project_id,
    email,
    role,
    expires_at,
    created_by
  )
  values (
    encode(digest(generated_token, 'sha256'), 'hex'),
    invited_project_id,
    clean_email,
    invite_role,
    invite_expires_at,
    auth.uid()
  )
  returning id into inserted_id;

  return query
  select
    inserted_id,
    clean_email,
    invited_project_id,
    invite_role,
    'https://exacth2o.com/portal.html?invite=' || generated_token,
    generated_token,
    invite_expires_at;
end;
$$;

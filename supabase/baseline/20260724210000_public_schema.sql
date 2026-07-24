


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."acquire_device_ingest_lease"("lease_project_id" "uuid", "lease_device_id" "text", "lease_holder" "uuid", "lease_seconds" integer DEFAULT 90) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  changed_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may acquire ingest leases';
  end if;

  insert into public.device_ingest_leases (
    project_id,
    device_id,
    holder,
    expires_at,
    updated_at
  ) values (
    lease_project_id,
    trim(lease_device_id),
    lease_holder,
    now() + make_interval(secs => least(greatest(lease_seconds, 15), 300)),
    now()
  )
  on conflict (project_id, device_id) do update
  set holder = excluded.holder,
      expires_at = excluded.expires_at,
      updated_at = now()
  where public.device_ingest_leases.expires_at <= now()
     or public.device_ingest_leases.holder = excluded.holder;

  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;


ALTER FUNCTION "public"."acquire_device_ingest_lease"("lease_project_id" "uuid", "lease_device_id" "text", "lease_holder" "uuid", "lease_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_project_invite_membership"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  project_member_role text := public.project_member_role_for_invite(new.role);
  portal_role text := public.portal_role_for_invite(new.role);
begin
  if new.accepted_at is null or new.accepted_by is null then
    return new;
  end if;

  if project_member_role is null or portal_role is null then
    raise exception 'Unsupported project invite role: %', new.role;
  end if;

  insert into public.profiles (id, email, full_name)
  values (
    new.accepted_by,
    lower(trim(new.email)),
    public.invite_profile_name(new.email)
  )
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(public.profiles.full_name, excluded.full_name);

  insert into public.project_members (project_id, user_id, role)
  values (new.project_id, new.accepted_by, project_member_role)
  on conflict (project_id, user_id) do update
  set role = excluded.role;

  insert into public.portal_access (project_id, user_id, email, role)
  values (
    new.project_id,
    new.accepted_by,
    lower(trim(new.email)),
    portal_role
  )
  on conflict (project_id, user_id) do update
  set email = excluded.email,
      role = excluded.role,
      updated_at = now();

  return new;
end;
$$;


ALTER FUNCTION "public"."apply_project_invite_membership"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attach_experiment_control_plan"("requested_experiment_id" "uuid", "requested_actor_id" "uuid", "reviewed_spec" "jsonb", "compiled_plan" "jsonb", "expected_inventory_updated_at" timestamp with time zone, "expected_config_hash" "text") RETURNS TABLE("plan_id" "uuid", "batch_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."attach_experiment_control_plan"("requested_experiment_id" "uuid", "requested_actor_id" "uuid", "reviewed_spec" "jsonb", "compiled_plan" "jsonb", "expected_inventory_updated_at" timestamp with time zone, "expected_config_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_public_submission"("submission_scope" "text", "submission_client_hash" "text", "max_requests" integer DEFAULT 5, "window_seconds" integer DEFAULT 600) RETURNS TABLE("allowed" boolean, "duplicate" boolean, "retry_after_seconds" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  safe_scope text := left(trim(coalesce(submission_scope, '')), 80);
  safe_max integer := least(greatest(max_requests, 1), 100);
  safe_window integer := least(greatest(window_seconds, 60), 86400);
  bucket_start timestamptz;
  current_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may check public submissions';
  end if;

  if safe_scope = '' or length(submission_client_hash) < 32 then
    raise exception 'Invalid public submission guard input';
  end if;

  bucket_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / safe_window) * safe_window
  );

  insert into public.public_submission_rate_limits (
    scope,
    client_hash,
    window_started_at,
    request_count,
    updated_at
  ) values (
    safe_scope,
    submission_client_hash,
    bucket_start,
    1,
    now()
  )
  on conflict (scope, client_hash, window_started_at) do update
  set request_count = public.public_submission_rate_limits.request_count + 1,
      updated_at = now()
  returning request_count into current_count;

  if current_count > safe_max then
    return query select false, false, greatest(1, safe_window - floor(extract(epoch from (clock_timestamp() - bucket_start)))::integer);
    return;
  end if;

  delete from public.public_submission_rate_limits
  where window_started_at <= now() - interval '2 days';

  return query select true, false, 0;
end;
$$;


ALTER FUNCTION "public"."check_public_submission"("submission_scope" "text", "submission_client_hash" "text", "max_requests" integer, "window_seconds" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."check_public_submission"("submission_scope" "text", "submission_client_hash" "text", "max_requests" integer, "window_seconds" integer) IS 'Atomic service-role rate limit. Public form persistence uses expiring fingerprint deduplication inside transactional save RPCs.';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."assistant_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "experiment_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "created_by_role" "text" NOT NULL,
    "name" "text" NOT NULL,
    "timezone" "text" NOT NULL,
    "recurrence" "text" NOT NULL,
    "approved_plan" "jsonb" NOT NULL,
    "approved_config_hash" "text",
    "review_token_hash" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "next_run_at" timestamp with time zone,
    "last_run_at" timestamp with time zone,
    "last_error" "text",
    "lease_until" timestamp with time zone,
    "confirmed_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "assistant_schedules_approved_plan_check" CHECK (("jsonb_typeof"("approved_plan") = 'object'::"text")),
    CONSTRAINT "assistant_schedules_created_by_role_check" CHECK (("created_by_role" = ANY (ARRAY['admin'::"text", 'researcher'::"text"]))),
    CONSTRAINT "assistant_schedules_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 120))),
    CONSTRAINT "assistant_schedules_recurrence_check" CHECK (("recurrence" = ANY (ARRAY['once'::"text", 'daily'::"text", 'weekly'::"text"]))),
    CONSTRAINT "assistant_schedules_review_token_hash_check" CHECK (("char_length"("review_token_hash") = 64)),
    CONSTRAINT "assistant_schedules_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'running'::"text", 'paused'::"text", 'completed'::"text", 'canceled'::"text", 'failed'::"text"]))),
    CONSTRAINT "assistant_schedules_timezone_check" CHECK ((("char_length"("timezone") >= 1) AND ("char_length"("timezone") <= 80)))
);


ALTER TABLE "public"."assistant_schedules" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_due_assistant_schedules"("claim_limit" integer DEFAULT 10) RETURNS SETOF "public"."assistant_schedules"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."claim_due_assistant_schedules"("claim_limit" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_key" "text" NOT NULL,
    "job_type" "text" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "available_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "lease_owner" "text",
    "lease_expires_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "rd_jobs_job_type_check" CHECK (("job_type" = ANY (ARRAY['predict'::"text", 'commit'::"text", 'observe'::"text", 'score'::"text", 'train'::"text"]))),
    CONSTRAINT "rd_jobs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'dead'::"text"])))
);


ALTER TABLE "public"."rd_jobs" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_jobs" IS 'R&D-only jobs with an independent lease. Never shared with health ingestion or controller commands.';



CREATE OR REPLACE FUNCTION "public"."claim_rd_jobs"("claim_worker" "text", "claim_limit" integer DEFAULT 10, "claim_lease_seconds" integer DEFAULT 120) RETURNS SETOF "public"."rd_jobs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may claim R&D jobs';
  end if;
  return query
  with candidates as (
    select jobs.id
    from public.rd_jobs jobs
    where jobs.status = 'queued'
      and jobs.available_at <= now()
    order by jobs.available_at, jobs.created_at
    for update skip locked
    limit greatest(1, least(claim_limit, 50))
  )
  update public.rd_jobs jobs
  set status = 'running',
      lease_owner = claim_worker,
      lease_expires_at = now() + make_interval(secs => greatest(30, claim_lease_seconds)),
      attempt_count = jobs.attempt_count + 1
  from candidates
  where jobs.id = candidates.id
  returning jobs.*;
end;
$$;


ALTER FUNCTION "public"."claim_rd_jobs"("claim_worker" "text", "claim_limit" integer, "claim_lease_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_rd_jobs_v3"("claim_worker" "text", "claim_kind" "text", "claim_limit" integer DEFAULT 1, "claim_lease_seconds" integer DEFAULT 900) RETURNS SETOF "public"."rd_jobs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may claim R&D jobs';
  end if;
  return query
  with candidates as (
    select jobs.id
    from public.rd_jobs jobs
    where jobs.job_type = claim_kind
      and (
        (jobs.status = 'queued' and jobs.available_at <= now())
        or (jobs.status = 'running' and jobs.lease_expires_at < now())
      )
    order by jobs.available_at, jobs.created_at
    for update skip locked
    limit greatest(1, least(claim_limit, 5))
  )
  update public.rd_jobs jobs
  set status = 'running',
      lease_owner = claim_worker,
      lease_expires_at = now() + make_interval(secs => greatest(120, claim_lease_seconds)),
      attempt_count = jobs.attempt_count + 1,
      last_error = null
  from candidates
  where jobs.id = candidates.id
  returning jobs.*;
end;
$$;


ALTER FUNCTION "public"."claim_rd_jobs_v3"("claim_worker" "text", "claim_kind" "text", "claim_limit" integer, "claim_lease_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") RETURNS TABLE("experiment_id" "uuid", "experiment_slug" "text", "experiment_status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."complete_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_device_control_token"("token_project_id" "uuid", "token_device_id" "text", "token_label" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  raw_token text;
  safe_device_id text := trim(coalesce(token_device_id, ''));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may create device control tokens';
  end if;

  if safe_device_id = '' then
    raise exception 'A device ID is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(token_project_id::text || ':' || safe_device_id, 0)
  );

  if exists (
    select 1
    from public.device_control_quarantines quarantine
    where quarantine.project_id = token_project_id
      and quarantine.device_id = safe_device_id
      and quarantine.active = true
  ) then
    raise exception 'Cannot issue a token while the device command stream is quarantined';
  end if;

  raw_token := encode(gen_random_bytes(32), 'hex');

  insert into public.device_control_tokens (
    project_id,
    device_id,
    label,
    token_hash
  ) values (
    token_project_id,
    safe_device_id,
    nullif(trim(token_label), ''),
    encode(digest(raw_token, 'sha256'), 'hex')
  );

  return raw_token;
end;
$$;


ALTER FUNCTION "public"."create_device_control_token"("token_project_id" "uuid", "token_device_id" "text", "token_label" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_project_invite"("invitee_email" "text", "invited_project_id" "uuid" DEFAULT '22222222-2222-4222-8222-222222222222'::"uuid", "invite_role" "text" DEFAULT 'owner'::"text", "invite_expires_at" timestamp with time zone DEFAULT ("now"() + '14 days'::interval)) RETURNS TABLE("invite_id" "uuid", "email" "text", "project_id" "uuid", "role" "text", "invite_url" "text", "raw_token" "text", "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $_$
declare
  clean_email text := lower(trim(invitee_email));
  generated_token text := encode(gen_random_bytes(32), 'hex');
  inserted_id uuid;
begin
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
$_$;


ALTER FUNCTION "public"."create_project_invite"("invitee_email" "text", "invited_project_id" "uuid", "invite_role" "text", "invite_expires_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_project_invite"("invitee_email" "text", "invited_project_id" "uuid", "invite_role" "text", "invite_expires_at" timestamp with time zone) IS 'Admin helper for one-time exactH2O portal invite links. Returns the raw token once; only token_hash is stored.';



CREATE OR REPLACE FUNCTION "public"."current_portal_role"("check_project_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select pa.role
  from public.portal_access pa
  where pa.project_id = check_project_id
    and pa.user_id = auth.uid()
  limit 1;
$$;


ALTER FUNCTION "public"."current_portal_role"("check_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."device_claim_control_command"("device_token" "text", "executor_version" "text" DEFAULT NULL::"text") RETURNS TABLE("id" "uuid", "project_id" "uuid", "device_id" "text", "command_type" "text", "payload" "jsonb", "requested_at" timestamp with time zone, "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
#variable_conflict use_column
declare
  authorized_device public.device_control_tokens%rowtype;
  claimed_id uuid;
  stale_count integer := 0;
begin
  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.token_hash = encode(digest(coalesce(device_token, ''), 'sha256'), 'hex')
    and dct.enabled = true
    and dct.revoked_at is null
  limit 1;

  if authorized_device.project_id is null then
    raise exception 'Invalid device token';
  end if;

  -- Serialize all enabled tokens/executor replicas for one physical device.
  perform pg_advisory_xact_lock(
    hashtextextended(authorized_device.project_id::text || ':' || authorized_device.device_id, 0)
  );

  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.id = authorized_device.id
    and dct.enabled = true
    and dct.revoked_at is null
  for update;

  if authorized_device.project_id is null then
    raise exception 'Device token was disabled while waiting for command lock';
  end if;

  if exists (
    select 1
    from public.device_control_quarantines quarantine
    where quarantine.project_id = authorized_device.project_id
      and quarantine.device_id = authorized_device.device_id
      and quarantine.active = true
  ) then
    raise exception 'Device command stream is quarantined';
  end if;

  update public.device_control_tokens dct
  set last_used_at = now()
  where dct.id = authorized_device.id;

  -- A timed-out hardware request is not fenceable from Postgres. Fail it, disable
  -- every token for the device, and require explicit state reconciliation before
  -- any later command can be claimed.
  with stale as (
    update public.project_control_commands pcc
    set
      status = 'failed',
      completed_at = now(),
      error = 'Command lease expired; device tokens disabled pending state reconciliation'
    where pcc.project_id = authorized_device.project_id
      and pcc.device_id = authorized_device.device_id
      and pcc.status = 'running'
      and (pcc.lease_expires_at is null or pcc.lease_expires_at <= now())
    returning pcc.id, pcc.project_id, pcc.device_id, pcc.lease_expires_at
  ), audited as (
    insert into public.project_control_audit (
      command_id,
      project_id,
      device_id,
      action,
      status,
      details
    )
    select
      stale.id,
      stale.project_id,
      stale.device_id,
      'device_lease_expired',
      'failed',
      jsonb_build_object(
        'lease_expires_at', stale.lease_expires_at,
        'requires_device_reconciliation', true
      )
    from stale
    returning 1
  )
  select count(*) into stale_count from audited;

  if stale_count > 0 then

    update public.device_control_tokens dct
    set enabled = false,
        disabled_at = now(),
        disabled_reason = 'command_lease_expired'
    where dct.project_id = authorized_device.project_id
      and dct.device_id = authorized_device.device_id
      and dct.revoked_at is null
      and dct.enabled = true;

    insert into public.device_control_quarantines (
      project_id,
      device_id,
      command_id,
      reason,
      active,
      quarantined_at,
      reconciled_at,
      reconciliation_details
    )
    select
      authorized_device.project_id,
      authorized_device.device_id,
      pcc.id,
      'Command lease expired; physical outcome requires reconciliation',
      true,
      now(),
      null,
      '{}'::jsonb
    from public.project_control_commands pcc
    where pcc.project_id = authorized_device.project_id
      and pcc.device_id = authorized_device.device_id
      and pcc.status = 'failed'
      and pcc.error = 'Command lease expired; device tokens disabled pending state reconciliation'
    order by pcc.completed_at desc
    limit 1
    on conflict (project_id, device_id) do update
    set command_id = excluded.command_id,
        reason = excluded.reason,
        active = true,
        quarantined_at = excluded.quarantined_at,
        reconciled_at = null,
        reconciliation_details = '{}'::jsonb;

    return;
  end if;

  if exists (
    select 1
    from public.project_control_commands pcc
    where pcc.project_id = authorized_device.project_id
      and pcc.device_id = authorized_device.device_id
      and pcc.status = 'running'
  ) then
    return;
  end if;

  update public.project_control_commands pcc
  set
    status = 'expired',
    completed_at = now(),
    lease_expires_at = null,
    error = 'Command expired before device executor claimed it'
  where pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
    and pcc.status in ('queued', 'accepted')
    and pcc.expires_at <= now();

  select pcc.id
  into claimed_id
  from public.project_control_commands pcc
  where pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
    and pcc.status in ('queued', 'accepted')
    and pcc.expires_at > now()
    and (
      pcc.depends_on_command_id is null
      or exists (
        select 1
        from public.project_control_commands prerequisite
        where prerequisite.id = pcc.depends_on_command_id
          and prerequisite.project_id = pcc.project_id
          and prerequisite.device_id = pcc.device_id
          and prerequisite.status = 'succeeded'
      )
    )
  order by pcc.requested_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.project_control_commands pcc
  set
    status = 'running',
    started_at = now(),
    lease_expires_at = now() + interval '2 minutes',
    attempt_count = pcc.attempt_count + 1,
    result = jsonb_build_object(
      'claimed_by', authorized_device.device_id,
      'executor_version', nullif(executor_version, ''),
      'claimed_at', now(),
      'lease_expires_at', now() + interval '2 minutes'
    )
  where pcc.id = claimed_id;

  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    status,
    details
  )
  select
    pcc.id,
    pcc.project_id,
    pcc.device_id,
    'device_claim',
    'running',
    jsonb_build_object(
      'executor_version', nullif(executor_version, ''),
      'lease_expires_at', pcc.lease_expires_at,
      'attempt_count', pcc.attempt_count
    )
  from public.project_control_commands pcc
  where pcc.id = claimed_id;

  return query
  select
    pcc.id,
    pcc.project_id,
    pcc.device_id,
    pcc.command_type,
    pcc.payload,
    pcc.requested_at,
    pcc.expires_at
  from public.project_control_commands pcc
  where pcc.id = claimed_id;
end;
$$;


ALTER FUNCTION "public"."device_claim_control_command"("device_token" "text", "executor_version" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."device_claim_control_command"("device_token" "text", "executor_version" "text") IS 'Claims one queued control command for the device identified by a device token. Intended for Balena-side executors using the anon key, not service_role.';



CREATE OR REPLACE FUNCTION "public"."device_complete_control_command"("device_token" "text", "command_id" "uuid", "final_status" "text", "command_result" "jsonb" DEFAULT '{}'::"jsonb", "command_error" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
#variable_conflict use_column
declare
  authorized_device public.device_control_tokens%rowtype;
  updated_count integer;
  current_status text;
begin
  if final_status not in ('succeeded', 'failed', 'canceled') then
    raise exception 'Invalid final status';
  end if;

  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.token_hash = encode(digest(coalesce(device_token, ''), 'sha256'), 'hex')
    and dct.enabled = true
    and dct.revoked_at is null
  limit 1;

  if authorized_device.project_id is null then
    raise exception 'Invalid device token';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(authorized_device.project_id::text || ':' || authorized_device.device_id, 0)
  );

  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.id = authorized_device.id
    and dct.enabled = true
    and dct.revoked_at is null
  for update;

  if authorized_device.project_id is null then
    raise exception 'Device token was disabled while waiting for command lock';
  end if;

  select pcc.status
  into current_status
  from public.project_control_commands pcc
  where pcc.id = command_id
    and pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
  for update;

  if current_status in ('succeeded', 'failed', 'canceled', 'expired') then
    return jsonb_build_object('ok', true, 'status', current_status, 'already_terminal', true);
  end if;

  update public.device_control_tokens dct
  set last_used_at = now()
  where dct.id = authorized_device.id;

  update public.project_control_commands pcc
  set
    status = final_status,
    completed_at = now(),
    lease_expires_at = null,
    result = coalesce(command_result, '{}'::jsonb),
    error = nullif(command_error, '')
  where pcc.id = command_id
    and pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
    and pcc.status = 'running'
    and pcc.lease_expires_at > now();

  get diagnostics updated_count = row_count;

  if updated_count <> 1 then
    raise exception 'Command is not running for this device';
  end if;

  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    status,
    details
  )
  values (
    command_id,
    authorized_device.project_id,
    authorized_device.device_id,
    'device_complete',
    final_status,
    jsonb_build_object(
      'result', coalesce(command_result, '{}'::jsonb),
      'error', nullif(command_error, '')
    )
  );

  return jsonb_build_object('ok', true, 'status', final_status);
end;
$$;


ALTER FUNCTION "public"."device_complete_control_command"("device_token" "text", "command_id" "uuid", "final_status" "text", "command_result" "jsonb", "command_error" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."device_complete_control_command"("device_token" "text", "command_id" "uuid", "final_status" "text", "command_result" "jsonb", "command_error" "text") IS 'Completes a running control command after the Balena-side executor applies or rejects it locally.';



CREATE OR REPLACE FUNCTION "public"."device_ingest"("device_token" "text", "payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  matched_device public.devices%rowtype;
  event jsonb;
  event_type text;
  inserted_readings integer := 0;
  inserted_valves integer := 0;
  duplicate_events integer := 0;
  row_count integer := 0;
begin
  select d.*
  into matched_device
  from public.devices d
  join public.device_secrets ds on ds.device_id = d.id
  where d.id = payload->>'device_id'
    and ds.revoked_at is null
    and ds.token_hash = encode(extensions.digest(device_token, 'sha256'), 'hex')
  limit 1;

  if not found then
    raise exception 'invalid device token' using errcode = '28000';
  end if;

  for event in select * from jsonb_array_elements(coalesce(payload->'events', '[]'::jsonb))
  loop
    event_type := event->>'type';

    if event_type = 'sensor_reading' then
      insert into public.sensor_readings (
        event_id,
        organization_id,
        project_id,
        device_id,
        source_sensor_id,
        sensor_key,
        pairing_name,
        device_recorded_at,
        raw_value,
        calibrated_value,
        temperature,
        electrical_conductivity,
        unit,
        quality_flags
      )
      values (
        event->>'event_id',
        matched_device.organization_id,
        matched_device.project_id,
        matched_device.id,
        nullif(event->>'source_sensor_id', '')::integer,
        event->>'sensor_key',
        event->>'pairing_name',
        coalesce((event->>'recorded_at')::timestamptz, now()),
        nullif(event->>'raw_value', '')::double precision,
        nullif(coalesce(event->>'calibrated_value', event->>'value'), '')::double precision,
        nullif(event->>'temperature', '')::double precision,
        nullif(event->>'electrical_conductivity', '')::double precision,
        coalesce(event->>'unit', 'vwc_pct'),
        coalesce(event->'quality_flags', '{}'::jsonb)
      )
      on conflict (event_id) do nothing;
      get diagnostics row_count = row_count;
      if row_count = 1 then
        inserted_readings := inserted_readings + 1;
      else
        duplicate_events := duplicate_events + 1;
      end if;

    elsif event_type = 'valve_event' then
      insert into public.valve_events (
        event_id,
        organization_id,
        project_id,
        device_id,
        source_valve_id,
        valve_key,
        pairing_name,
        action,
        duration_ms,
        reason,
        device_recorded_at
      )
      values (
        event->>'event_id',
        matched_device.organization_id,
        matched_device.project_id,
        matched_device.id,
        nullif(event->>'source_valve_id', '')::integer,
        event->>'valve_key',
        event->>'pairing_name',
        event->>'action',
        nullif(event->>'duration_ms', '')::integer,
        event->>'reason',
        coalesce((event->>'recorded_at')::timestamptz, now())
      )
      on conflict (event_id) do nothing;
      get diagnostics row_count = row_count;
      if row_count = 1 then
        inserted_valves := inserted_valves + 1;
      else
        duplicate_events := duplicate_events + 1;
      end if;
    end if;
  end loop;

  update public.devices
  set status = 'online',
      last_seen_at = now()
  where id = matched_device.id;

  insert into public.latest_device_state (
    device_id,
    organization_id,
    project_id,
    last_seen_at,
    health_status,
    latest_payload,
    updated_at
  )
  values (
    matched_device.id,
    matched_device.organization_id,
    matched_device.project_id,
    now(),
    'online',
    jsonb_build_object(
      'sent_at', payload->>'sent_at',
      'event_count', jsonb_array_length(coalesce(payload->'events', '[]'::jsonb)),
      'inserted_readings', inserted_readings,
      'inserted_valves', inserted_valves,
      'duplicate_events', duplicate_events
    ),
    now()
  )
  on conflict (device_id) do update
  set last_seen_at = excluded.last_seen_at,
      health_status = excluded.health_status,
      latest_payload = excluded.latest_payload,
      updated_at = now();

  return jsonb_build_object(
    'ok', true,
    'device_id', matched_device.id,
    'inserted_readings', inserted_readings,
    'inserted_valves', inserted_valves,
    'duplicate_events', duplicate_events
  );
end;
$$;


ALTER FUNCTION "public"."device_ingest"("device_token" "text", "payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."device_quarantine_control_command"("device_token" "text", "command_id" "uuid", "quarantine_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  authorized_device public.device_control_tokens%rowtype;
  current_status text;
  safe_reason text := left(coalesce(nullif(trim(quarantine_reason), ''), 'Controller mutation outcome is unknown'), 1000);
begin
  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.token_hash = encode(digest(coalesce(device_token, ''), 'sha256'), 'hex')
    and dct.revoked_at is null
  limit 1;

  if authorized_device.project_id is null then
    raise exception 'Invalid device token';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(authorized_device.project_id::text || ':' || authorized_device.device_id, 0)
  );

  select pcc.status
  into current_status
  from public.project_control_commands pcc
  where pcc.id = command_id
    and pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
  for update;

  if current_status is null then
    raise exception 'Command does not belong to this device';
  end if;

  if current_status in ('succeeded', 'failed', 'canceled', 'expired') then
    return jsonb_build_object('ok', true, 'status', current_status, 'already_terminal', true);
  end if;

  if current_status <> 'running' then
    raise exception 'Only a running command can be quarantined';
  end if;

  update public.project_control_commands pcc
  set status = 'failed',
      completed_at = now(),
      lease_expires_at = null,
      error = safe_reason,
      result = coalesce(pcc.result, '{}'::jsonb) || jsonb_build_object(
        'requires_device_reconciliation', true,
        'quarantined_at', now()
      )
  where pcc.id = command_id;

  update public.device_control_tokens dct
  set enabled = false,
      disabled_at = now(),
      disabled_reason = 'command_quarantine'
  where dct.project_id = authorized_device.project_id
    and dct.device_id = authorized_device.device_id
    and dct.revoked_at is null
    and dct.enabled = true;

  insert into public.device_control_quarantines (
    project_id,
    device_id,
    command_id,
    reason,
    active,
    quarantined_at,
    reconciled_at,
    reconciliation_details
  ) values (
    authorized_device.project_id,
    authorized_device.device_id,
    command_id,
    safe_reason,
    true,
    now(),
    null,
    '{}'::jsonb
  )
  on conflict (project_id, device_id) do update
  set command_id = excluded.command_id,
      reason = excluded.reason,
      active = true,
      quarantined_at = excluded.quarantined_at,
      reconciled_at = null,
      reconciliation_details = '{}'::jsonb;

  with canceled as (
    update public.project_control_commands pcc
    set status = 'canceled',
        completed_at = now(),
        lease_expires_at = null,
        error = 'Canceled because the device command stream requires reconciliation'
    where pcc.project_id = authorized_device.project_id
      and pcc.device_id = authorized_device.device_id
      and pcc.status in ('queued', 'accepted')
    returning pcc.id, pcc.project_id, pcc.device_id
  )
  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    status,
    details
  )
  select
    canceled.id,
    canceled.project_id,
    canceled.device_id,
    'device_quarantine_cancel_pending',
    'canceled',
    jsonb_build_object('requires_resubmission', true)
  from canceled;

  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    status,
    details
  ) values (
    command_id,
    authorized_device.project_id,
    authorized_device.device_id,
    'device_quarantine',
    'failed',
    jsonb_build_object(
      'reason', safe_reason,
      'requires_device_reconciliation', true
    )
  );

  return jsonb_build_object('ok', true, 'status', 'failed', 'quarantined', true);
end;
$$;


ALTER FUNCTION "public"."device_quarantine_control_command"("device_token" "text", "command_id" "uuid", "quarantine_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."device_renew_control_command_lease"("device_token" "text", "command_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  authorized_device public.device_control_tokens%rowtype;
  updated_count integer;
begin
  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.token_hash = encode(digest(coalesce(device_token, ''), 'sha256'), 'hex')
    and dct.enabled = true
    and dct.revoked_at is null
  limit 1;

  if authorized_device.project_id is null then
    raise exception 'Invalid device token';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(authorized_device.project_id::text || ':' || authorized_device.device_id, 0)
  );

  select *
  into authorized_device
  from public.device_control_tokens dct
  where dct.id = authorized_device.id
    and dct.enabled = true
    and dct.revoked_at is null
  for update;

  if authorized_device.project_id is null then
    raise exception 'Device token was disabled while waiting for command lock';
  end if;

  update public.project_control_commands pcc
  set lease_expires_at = now() + interval '2 minutes'
  where pcc.id = command_id
    and pcc.project_id = authorized_device.project_id
    and pcc.device_id = authorized_device.device_id
    and pcc.status = 'running'
    and pcc.lease_expires_at > now();

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;


ALTER FUNCTION "public"."device_renew_control_command_lease"("device_token" "text", "command_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."device_renew_control_command_lease"("device_token" "text", "command_id" "uuid") IS 'Extends a still-valid running command lease for the device that owns the command.';



CREATE TABLE IF NOT EXISTS "public"."project_control_commands" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text",
    "command_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "requested_by" "uuid" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval) NOT NULL,
    "requires_confirmation" boolean DEFAULT false NOT NULL,
    "confirmed_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "result" "jsonb",
    "error" "text",
    "lease_expires_at" timestamp with time zone,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "client_request_id" "uuid",
    "depends_on_command_id" "uuid",
    "batch_id" "uuid",
    "experiment_id" "uuid",
    CONSTRAINT "project_control_commands_command_type_check" CHECK (("command_type" = ANY (ARRAY['update_pairing'::"text", 'bulk_update_pairings'::"text", 'create_pairing'::"text", 'delete_pairing'::"text", 'create_group'::"text", 'remove_group'::"text", 'create_calibration'::"text", 'delete_calibration'::"text", 'apply_calibration'::"text", 'manual_water'::"text", 'update_board_config'::"text", 'initialize_sensors'::"text", 'update_system_state'::"text", 'export_data'::"text"]))),
    CONSTRAINT "project_control_commands_confirmation_check" CHECK ((("requires_confirmation" = false) OR ("confirmed_at" IS NOT NULL))),
    CONSTRAINT "project_control_commands_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'accepted'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'canceled'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."project_control_commands" OWNER TO "postgres";


COMMENT ON TABLE "public"."project_control_commands" IS 'Authenticated portal control requests. Edge Functions insert rows; device-side executors apply queued commands and write results.';



COMMENT ON COLUMN "public"."project_control_commands"."lease_expires_at" IS 'Fail-closed executor lease. Expired running commands are marked failed and are never automatically replayed.';



COMMENT ON COLUMN "public"."project_control_commands"."depends_on_command_id" IS 'Prevents claim until the prerequisite command succeeds; failure cancels the chain.';



CREATE OR REPLACE FUNCTION "public"."enqueue_portal_control_command"("command_project_id" "uuid", "command_device_id" "text", "command_type" "text", "command_payload" "jsonb", "command_requested_by" "uuid", "command_expires_at" timestamp with time zone, "command_requires_confirmation" boolean, "command_confirmed_at" timestamp with time zone, "command_client_request_id" "uuid") RETURNS SETOF "public"."project_control_commands"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  queued_command public.project_control_commands%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may enqueue portal control commands';
  end if;

  if command_device_id is null or trim(command_device_id) = '' then
    raise exception 'A device ID is required for control commands';
  end if;

  if command_client_request_id is null then
    raise exception 'A client request ID is required for control commands';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(command_project_id::text || ':' || trim(command_device_id), 0)
  );

  select pcc.*
  into queued_command
  from public.project_control_commands pcc
  where pcc.project_id = command_project_id
    and pcc.requested_by = command_requested_by
    and pcc.client_request_id = command_client_request_id
  limit 1;

  if queued_command.id is not null then
    return next queued_command;
    return;
  end if;

  if exists (
    select 1
    from public.device_control_quarantines quarantine
    where quarantine.project_id = command_project_id
      and quarantine.device_id = trim(command_device_id)
      and quarantine.active = true
  ) then
    raise exception 'Device command stream is disabled or quarantined';
  end if;

  if not exists (
    select 1
    from public.device_control_tokens dct
    where dct.project_id = command_project_id
      and dct.device_id = trim(command_device_id)
      and dct.enabled = true
      and dct.revoked_at is null
  ) then
    raise exception 'Device command stream has no enabled executor token';
  end if;

  if command_type = 'manual_water' and exists (
    select 1
    from public.project_control_commands pcc
    where pcc.project_id = command_project_id
      and pcc.device_id = trim(command_device_id)
      and pcc.command_type = 'manual_water'
      and (
        pcc.status = 'running'
        or (pcc.status in ('queued', 'accepted') and pcc.expires_at > now())
        or coalesce(pcc.completed_at, pcc.requested_at) > now() - interval '60 seconds'
      )
  ) then
    raise exception 'Manual watering is already active or cooling down for this device';
  end if;

  insert into public.project_control_commands (
    project_id,
    device_id,
    command_type,
    payload,
    requested_by,
    expires_at,
    requires_confirmation,
    confirmed_at,
    client_request_id
  ) values (
    command_project_id,
    trim(command_device_id),
    command_type,
    coalesce(command_payload, '{}'::jsonb),
    command_requested_by,
    command_expires_at,
    command_requires_confirmation,
    command_confirmed_at,
    command_client_request_id
  )
  returning * into queued_command;

  insert into public.project_control_audit (
    command_id,
    project_id,
    device_id,
    action,
    actor_id,
    status,
    details
  ) values (
    queued_command.id,
    command_project_id,
    trim(command_device_id),
    command_type,
    command_requested_by,
    'queued',
    jsonb_build_object(
      'payload', coalesce(command_payload, '{}'::jsonb),
      'requires_confirmation', command_requires_confirmation,
      'client_request_id', command_client_request_id
    )
  );

  return next queued_command;
end;
$$;


ALTER FUNCTION "public"."enqueue_portal_control_command"("command_project_id" "uuid", "command_device_id" "text", "command_type" "text", "command_payload" "jsonb", "command_requested_by" "uuid", "command_expires_at" timestamp with time zone, "command_requires_confirmation" boolean, "command_confirmed_at" timestamp with time zone, "command_client_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_portal_control_command_batch"("command_project_id" "uuid", "command_device_id" "text", "command_requested_by" "uuid", "command_batch_id" "uuid", "command_expires_at" timestamp with time zone, "expected_config_hash" "text", "expected_controller_state" "text", "batch_commands" "jsonb") RETURNS SETOF "public"."project_control_commands"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  command_item jsonb;
  command_index integer := 0;
  command_count integer;
  command_type_value text;
  command_payload_value jsonb;
  command_client_id uuid;
  previous_command_id uuid;
  queued_command public.project_control_commands%rowtype;
  current_config_hash text;
  current_controller_state text;
  current_state_fresh_until timestamptz;
  normalized_expected_controller_state text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may enqueue portal control command batches';
  end if;
  if command_batch_id is null then
    raise exception 'A command batch ID is required';
  end if;
  if jsonb_typeof(batch_commands) <> 'array' then
    raise exception 'Batch commands must be an array';
  end if;

  command_count := jsonb_array_length(batch_commands);
  if command_count < 3 or command_count > 22 then
    raise exception 'A settings batch must contain 3-22 commands';
  end if;
  normalized_expected_controller_state := lower(trim(coalesce(expected_controller_state, '')));
  if normalized_expected_controller_state not in ('running', 'stopped') then
    raise exception 'The reviewed controller state is invalid';
  end if;
  if batch_commands->0->>'command_type' <> 'update_system_state'
    or batch_commands->0->'payload'->>'state' <> 'stopped'
    or batch_commands->(command_count - 1)->>'command_type' <> 'update_system_state'
    or batch_commands->(command_count - 1)->'payload'->>'state' <> normalized_expected_controller_state then
    raise exception 'A settings batch must stop first and restore the reviewed state last';
  end if;

  select config.config_hash
  into current_config_hash
  from public.device_config_state config
  where config.project_id = command_project_id
    and config.device_id = trim(command_device_id)
  order by config.updated_at desc
  limit 1;
  if current_config_hash is null
    or current_config_hash is distinct from expected_config_hash then
    raise exception 'Controller configuration changed before the settings batch was queued';
  end if;

  select lower(trim(runtime.controller_state)), runtime.state_fresh_until
  into current_controller_state, current_state_fresh_until
  from public.device_runtime_state runtime
  where runtime.project_id = command_project_id
    and runtime.device_id = trim(command_device_id)
  order by runtime.updated_at desc
  limit 1;
  if current_controller_state is null
    or current_controller_state is distinct from normalized_expected_controller_state
    or current_state_fresh_until is null
    or current_state_fresh_until <= now() then
    raise exception 'Controller state changed or is stale; refresh before applying settings';
  end if;

  for command_item in select value from jsonb_array_elements(batch_commands)
  loop
    command_index := command_index + 1;
    command_type_value := command_item->>'command_type';
    command_payload_value := command_item->'payload';
    command_client_id := (command_item->>'client_request_id')::uuid;

    if command_client_id is null or jsonb_typeof(command_payload_value) <> 'object' then
      raise exception 'A settings batch command is invalid';
    end if;
    if command_index > 1 and command_index < command_count
      and command_type_value not in (
        'update_pairing',
        'bulk_update_pairings',
        'create_pairing',
        'delete_pairing',
        'create_group',
        'remove_group',
        'create_calibration',
        'delete_calibration',
        'apply_calibration',
        'update_board_config'
      ) then
      raise exception 'A settings batch contains an unsupported configuration command';
    end if;

    select *
    into queued_command
    from public.enqueue_portal_control_command(
      command_project_id,
      command_device_id,
      command_type_value,
      command_payload_value,
      command_requested_by,
      command_expires_at,
      coalesce((command_item->>'requires_confirmation')::boolean, false),
      case
        when coalesce((command_item->>'requires_confirmation')::boolean, false)
          then now()
        else null
      end,
      command_client_id
    )
    limit 1;

    if queued_command.batch_id is not null
      and (
        queued_command.batch_id is distinct from command_batch_id
        or queued_command.experiment_id is not null
        or queued_command.depends_on_command_id is distinct from previous_command_id
      ) then
      raise exception 'Existing command metadata does not match the settings batch';
    end if;

    update public.project_control_commands
    set batch_id = command_batch_id,
        experiment_id = null,
        depends_on_command_id = previous_command_id
    where id = queued_command.id
    returning * into queued_command;

    previous_command_id := queued_command.id;
    return next queued_command;
  end loop;
end;
$$;


ALTER FUNCTION "public"."enqueue_portal_control_command_batch"("command_project_id" "uuid", "command_device_id" "text", "command_requested_by" "uuid", "command_batch_id" "uuid", "command_expires_at" timestamp with time zone, "expected_config_hash" "text", "expected_controller_state" "text", "batch_commands" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."enqueue_portal_control_command_batch"("command_project_id" "uuid", "command_device_id" "text", "command_requested_by" "uuid", "command_batch_id" "uuid", "command_expires_at" timestamp with time zone, "expected_config_hash" "text", "expected_controller_state" "text", "batch_commands" "jsonb") IS 'Atomically enqueues a reviewed STOP-config-restore settings chain against exact mirrored config and runtime state.';



CREATE OR REPLACE FUNCTION "public"."enqueue_portal_control_command_v2"("command_project_id" "uuid", "command_device_id" "text", "command_type" "text", "command_payload" "jsonb", "command_requested_by" "uuid", "command_expires_at" timestamp with time zone, "command_requires_confirmation" boolean, "command_confirmed_at" timestamp with time zone, "command_client_request_id" "uuid", "command_depends_on_id" "uuid" DEFAULT NULL::"uuid", "command_batch_id" "uuid" DEFAULT NULL::"uuid", "command_experiment_id" "uuid" DEFAULT NULL::"uuid") RETURNS SETOF "public"."project_control_commands"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."enqueue_portal_control_command_v2"("command_project_id" "uuid", "command_device_id" "text", "command_type" "text", "command_payload" "jsonb", "command_requested_by" "uuid", "command_expires_at" timestamp with time zone, "command_requires_confirmation" boolean, "command_confirmed_at" timestamp with time zone, "command_client_request_id" "uuid", "command_depends_on_id" "uuid", "command_batch_id" "uuid", "command_experiment_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finish_assistant_schedule_run"("requested_schedule_id" "uuid", "run_status" "text", "run_batch_id" "uuid" DEFAULT NULL::"uuid", "run_details" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."finish_assistant_schedule_run"("requested_schedule_id" "uuid", "run_status" "text", "run_batch_id" "uuid", "run_details" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_portal_access"("check_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.portal_access pa
    where pa.project_id = check_project_id
      and pa.user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."has_portal_access"("check_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_rd_system_admin_access"("check_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.rd_system_admin_access access
    where access.project_id = check_project_id
      and access.user_id = auth.uid()
      and access.enabled = true
      and access.revoked_at is null
  );
$$;


ALTER FUNCTION "public"."has_rd_system_admin_access"("check_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invite_profile_name"("invite_email" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case lower(trim(invite_email))
    when 'howeeva1@msu.edu' then 'EJ Howe'
    when 'howeej2255@gmail.com' then 'EJ Howe'
    when 'statamat@msu.edu' then 'Matt Stata'
    when 'basyalbi@msu.edu' then 'Binod Basyal'
    when 'hicksj23@msu.edu' then 'Jake Hicks'
    when 'berkley@msu.edu' then 'Berkley'
    else split_part(lower(trim(invite_email)), '@', 1)
  end;
$$;


ALTER FUNCTION "public"."invite_profile_name"("invite_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invoke_assistant_automation_runner"() RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'vault', 'net'
    AS $$
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


ALTER FUNCTION "public"."invoke_assistant_automation_runner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invoke_owner_health_sync"() RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'vault', 'net'
    AS $$
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
    raise exception 'Owner-health Cron secret is missing or too short';
  end if;

  select net.http_post(
    url := 'https://zmhdclcjrkntrpynozvo.supabase.co/functions/v1/sync-owner-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-owner-health-secret', cron_secret
    ),
    body := jsonb_build_object('source', 'supabase_cron_watchdog'),
    timeout_milliseconds := 25000
  )
  into request_id;

  return request_id;
end;
$$;


ALTER FUNCTION "public"."invoke_owner_health_sync"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."invoke_owner_health_sync"() IS 'Queues the server-authorized owner-health Edge Function through pg_net. The encrypted Cron secret must be provisioned separately in Vault.';



CREATE OR REPLACE FUNCTION "public"."is_portal_admin"("check_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.portal_access pa
    where pa.project_id = check_project_id
      and pa.user_id = auth.uid()
      and pa.role = 'admin'
  );
$$;


ALTER FUNCTION "public"."is_portal_admin"("check_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_project_member"("target_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = target_project_id
      and pm.user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_project_member"("target_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_experiment_activation_enqueue_failed"("requested_plan_id" "uuid", "failure_message" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."mark_experiment_activation_enqueue_failed"("requested_plan_id" "uuid", "failure_message" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."member_organization_ids"() RETURNS TABLE("allowed_organization_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select distinct project.organization_id
  from public.projects project
  join public.project_members membership
    on membership.project_id = project.id
  where membership.user_id = (select auth.uid());
$$;


ALTER FUNCTION "public"."member_organization_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."member_project_ids"() RETURNS TABLE("allowed_project_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select membership.project_id
  from public.project_members membership
  where membership.user_id = (select auth.uid());
$$;


ALTER FUNCTION "public"."member_project_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mirror_live_sensor_readings"("reading_rows" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  inserted_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may mirror live sensor readings';
  end if;
  if jsonb_typeof(reading_rows) <> 'array' then
    raise exception 'reading_rows must be a JSON array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('exacth2o:live-reading-mirror', 0));

  with candidate_rows as (
    select *
    from jsonb_to_recordset(reading_rows) as row_data(
      organization_id uuid,
      project_id uuid,
      device_id text,
      event_id text,
      pairing_name text,
      sensor_key text,
      raw_value double precision,
      calibrated_value double precision,
      temperature double precision,
      electrical_conductivity double precision,
      device_recorded_at timestamptz,
      server_received_at timestamptz
    )
    where project_id = '22222222-2222-4222-8222-222222222222'::uuid
      and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
      and event_id like 'live-device:%'
      and pairing_name is not null
      and calibrated_value is not null
      and device_recorded_at is not null
      and server_received_at is not null
  ), inserted as (
    insert into public.sensor_readings (
      organization_id, project_id, device_id, event_id, pairing_name, sensor_key,
      raw_value, calibrated_value, temperature, electrical_conductivity,
      device_recorded_at, server_received_at
    )
    select
      candidate.organization_id, candidate.project_id, candidate.device_id,
      candidate.event_id, candidate.pairing_name, candidate.sensor_key,
      candidate.raw_value, candidate.calibrated_value, candidate.temperature,
      candidate.electrical_conductivity, candidate.device_recorded_at,
      candidate.server_received_at
    from candidate_rows candidate
    where not exists (
      select 1 from public.sensor_readings existing
      where existing.event_id = candidate.event_id
    )
    returning 1
  )
  select count(*) into inserted_count from inserted;

  return inserted_count;
end;
$$;


ALTER FUNCTION "public"."mirror_live_sensor_readings"("reading_rows" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."mirror_live_sensor_readings"("reading_rows" "jsonb") IS 'Idempotently mirrors verified owner-health readings for portal and shadow R&D use. No controller write path.';



CREATE OR REPLACE FUNCTION "public"."portal_admin_project_ids"() RETURNS TABLE("allowed_project_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select pa.project_id
  from public.portal_access pa
  where pa.user_id = (select auth.uid())
    and pa.role = 'admin';
$$;


ALTER FUNCTION "public"."portal_admin_project_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."portal_project_ids"() RETURNS TABLE("allowed_project_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select pa.project_id
  from public.portal_access pa
  where pa.user_id = (select auth.uid());
$$;


ALTER FUNCTION "public"."portal_project_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."portal_role_for_email"("account_email" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case lower(trim(account_email))
    when 'howeeva1@msu.edu' then 'admin'
    when 'basyalbi@msu.edu' then 'admin'
    when 'hicksj23@msu.edu' then 'admin'
    when 'berkley@msu.edu' then 'admin'
    when 'statamat@msu.edu' then 'researcher'
    when 'howeej2255@gmail.com' then 'researcher'
    else null
  end;
$$;


ALTER FUNCTION "public"."portal_role_for_email"("account_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."portal_role_for_invite"("invite_role" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case invite_role
    when 'owner' then 'admin'
    when 'admin' then 'admin'
    when 'member' then 'researcher'
    when 'viewer' then 'viewer'
    else null
  end;
$$;


ALTER FUNCTION "public"."portal_role_for_invite"("invite_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."project_member_role_for_invite"("invite_role" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case invite_role
    when 'owner' then 'owner'
    when 'admin' then 'admin'
    when 'member' then 'researcher'
    when 'viewer' then 'viewer'
    else null
  end;
$$;


ALTER FUNCTION "public"."project_member_role_for_invite"("invite_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promote_rd_model"("promote_project_id" "uuid", "promote_model_version_id" "uuid", "promotion_evidence" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  previous_model_id uuid;
  promotion_id uuid;
  candidate_is_synthetic boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may promote R&D models';
  end if;
  if coalesce((promotion_evidence ->> 'qualified_evaluation_windows')::integer, 0) < 2 then
    raise exception 'Promotion requires at least two qualified evaluation windows';
  end if;
  select synthetic_data_only into candidate_is_synthetic
  from public.rd_model_versions
  where id = promote_model_version_id and status = 'candidate'
  for update;
  if not found or candidate_is_synthetic then
    raise exception 'Only a non-synthetic candidate may be promoted';
  end if;
  select id into previous_model_id
  from public.rd_model_versions
  where status = 'champion'
  for update;

  perform set_config('exacth2o.rd_promotion_context', 'authorized', true);
  if previous_model_id is not null then
    update public.rd_model_versions set status = 'retired' where id = previous_model_id;
  end if;
  insert into public.rd_model_promotions (
    project_id, model_version_id, previous_model_version_id, decision, evidence, actor_id
  ) values (
    promote_project_id, promote_model_version_id, previous_model_id, 'promoted',
    promotion_evidence, auth.uid()
  ) returning id into promotion_id;
  update public.rd_model_versions set status = 'champion' where id = promote_model_version_id;
  return promotion_id;
end;
$$;


ALTER FUNCTION "public"."promote_rd_model"("promote_project_id" "uuid", "promote_model_version_id" "uuid", "promotion_evidence" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_device_health_history"("retention_days" integer DEFAULT 30) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  deleted_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may prune device health history';
  end if;

  delete from public.device_health_snapshots
  where captured_at < now() - make_interval(days => least(greatest(retention_days, 1), 365));

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;


ALTER FUNCTION "public"."prune_device_health_history"("retention_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."publish_sensing_experiment"("requested_project_id" "uuid", "reviewed_spec" "jsonb", "expected_inventory_updated_at" timestamp with time zone, "draft_source" "text" DEFAULT 'manual'::"text", "draft_model_name" "text" DEFAULT NULL::"text", "draft_prompt_fingerprint" "text" DEFAULT NULL::"text") RETURNS TABLE("experiment_id" "uuid", "experiment_slug" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare
  caller_id uuid := auth.uid();
  caller_role text;
  record_project_id uuid;
  config_record public.device_config_state%rowtype;
  spec_name text;
  spec_description text;
  spec_mode text;
  spec_start_at timestamptz;
  spec_assignments jsonb;
  assignment_count integer;
  distinct_assignment_count integer;
  slug_base text;
  selected_slug text;
  suffix integer := 2;
  created_experiment_id uuid := gen_random_uuid();
  created_revision_id uuid := gen_random_uuid();
  config_pairing jsonb;
  assignment jsonb;
  assignment_name text;
  zone_match text[];
  selected_sensor_keys text[] := '{}'::text[];
  selected_valve_keys text[] := '{}'::text[];
  selected_sensor_key text;
  selected_valve_key text;
begin
  if caller_id is null then
    raise exception 'Authentication is required';
  end if;

  select pa.role
  into caller_role
  from public.portal_access pa
  where pa.user_id = caller_id
    and pa.project_id = requested_project_id
    and pa.role in ('admin', 'researcher')
  limit 1;

  if caller_role is null then
    raise exception 'Researcher or administrator access is required';
  end if;
  record_project_id := requested_project_id;

  if draft_source not in ('manual', 'natural_language') then
    raise exception 'Invalid draft source';
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
  if spec_mode not in ('observation', 'calibration') then
    raise exception 'Only sensing-only observation or calibration experiments can be published';
  end if;
  if jsonb_typeof(reviewed_spec->'watering_requested') = 'boolean'
    and (reviewed_spec->>'watering_requested')::boolean then
    raise exception 'Watering cannot be enabled by the experiment builder';
  end if;
  if jsonb_typeof(spec_assignments) <> 'array' then
    raise exception 'Assignments must be a list';
  end if;

  assignment_count := jsonb_array_length(spec_assignments);
  if assignment_count < 1 or assignment_count > 100 then
    raise exception 'Select 1-100 pots';
  end if;

  select count(distinct item->>'pairing_name')
  into distinct_assignment_count
  from jsonb_array_elements(spec_assignments) item;
  if distinct_assignment_count <> assignment_count then
    raise exception 'Each pairing can be selected only once';
  end if;

  select d.*
  into config_record
  from public.device_config_state d
  where d.project_id = record_project_id
  order by d.updated_at desc
  limit 1;

  if config_record.project_id is null then
    raise exception 'Current device configuration is unavailable';
  end if;
  if expected_inventory_updated_at is null
    or config_record.updated_at <> expected_inventory_updated_at then
    raise exception 'The device inventory changed. Generate or review the draft again.';
  end if;

  if nullif(reviewed_spec->>'start_date', '') is not null then
    begin
      spec_start_at := (reviewed_spec->>'start_date')::timestamptz;
    exception when others then
      raise exception 'Start date is invalid';
    end;
  end if;

  slug_base := left(
    trim(both '-' from regexp_replace(lower(spec_name), '[^a-z0-9]+', '-', 'g')),
    72
  );
  if slug_base = '' then
    slug_base := 'experiment';
  end if;
  selected_slug := slug_base;
  while exists (
    select 1 from public.experiments e
    where e.project_id = record_project_id and e.slug = selected_slug
  ) loop
    selected_slug := left(slug_base, 72 - char_length(suffix::text) - 1) || '-' || suffix::text;
    suffix := suffix + 1;
  end loop;

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

  insert into public.experiments (
    id, project_id, slug, name, description, mode, status, watering_state,
    visible_to_roles, started_at, created_by
  ) values (
    created_experiment_id, record_project_id, selected_slug, spec_name,
    spec_description, spec_mode, 'published_sensing', 'off',
    array['admin', 'researcher']::text[], spec_start_at, caller_id
  );

  insert into public.experiment_revisions (
    id, experiment_id, project_id, version, source, spec,
    inventory_updated_at, inventory_hash, model_name, prompt_fingerprint, created_by
  ) values (
    created_revision_id, created_experiment_id, record_project_id, 1, draft_source,
    reviewed_spec || jsonb_build_object(
      'watering_requested', false,
      'watering_state', 'off'
    ),
    config_record.updated_at, config_record.config_hash, draft_model_name,
    draft_prompt_fingerprint, caller_id
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

    insert into public.experiment_assignments (
      revision_id, experiment_id, project_id, pairing_name, zone, pot_number,
      crop, treatment, block, substrate, target_vwc_percent,
      measurement_interval_minutes, notes, sensor_key_snapshot,
      valve_key_snapshot, calibration_name_snapshot, source_target_vwc_percent,
      source_valve_open_time_ms, source_measurement_interval_ms
    ) values (
      created_revision_id, created_experiment_id, record_project_id, assignment_name,
      zone_match[1]::integer, zone_match[2]::integer,
      nullif(btrim(assignment->>'crop'), ''),
      nullif(btrim(assignment->>'treatment'), ''),
      nullif(btrim(assignment->>'block'), ''),
      nullif(btrim(assignment->>'substrate'), ''),
      case when jsonb_typeof(assignment->'target_vwc_percent') = 'number'
        then (assignment->>'target_vwc_percent')::double precision else null end,
      case when jsonb_typeof(assignment->'measurement_interval_minutes') = 'number'
        then (assignment->>'measurement_interval_minutes')::double precision else null end,
      nullif(btrim(assignment->>'notes'), ''),
      (config_pairing->'Sensor'->>'boardSerialId') || ':' || (config_pairing->'Sensor'->>'address'),
      (config_pairing->'Valve'->>'relayAddress') || ':' || (config_pairing->'Valve'->>'address'),
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
  set current_revision_id = created_revision_id, updated_at = now()
  where id = created_experiment_id;

  insert into public.experiment_audit_events (
    experiment_id, project_id, revision_id, event_type, actor_id, details
  ) values (
    created_experiment_id, record_project_id, created_revision_id,
    'published_sensing', caller_id,
    jsonb_build_object(
      'source', draft_source,
      'model', draft_model_name,
      'assignment_count', assignment_count,
      'watering_state', 'off'
    )
  );

  return query select created_experiment_id, selected_slug;
end;
$_$;


ALTER FUNCTION "public"."publish_sensing_experiment"("requested_project_id" "uuid", "reviewed_spec" "jsonb", "expected_inventory_updated_at" timestamp with time zone, "draft_source" "text", "draft_model_name" "text", "draft_prompt_fingerprint" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."publish_sensing_experiment"("requested_project_id" "uuid", "reviewed_spec" "jsonb", "expected_inventory_updated_at" timestamp with time zone, "draft_source" "text", "draft_model_name" "text", "draft_prompt_fingerprint" "text") IS 'Publishes a validated sensing-only experiment from the current device inventory; never mutates controller state.';



CREATE OR REPLACE FUNCTION "public"."rd_atomic_event_observation_v4"("observation_irrigation_event_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  selected_event public.rd_irrigation_events_v2%rowtype;
  result jsonb;
  control_pairings constant text[] := array[
    'Zone2-Pot41', 'Zone2-Pot43', 'Zone2-Pot45', 'Zone2-Pot47', 'Zone2-Pot49',
    'Zone4-Pot91', 'Zone4-Pot93', 'Zone4-Pot95', 'Zone4-Pot97', 'Zone4-Pot99'
  ];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may read private atomic R&D evidence';
  end if;
  select * into selected_event
  from public.rd_irrigation_events_v2
  where id = observation_irrigation_event_id
    and project_id = '22222222-2222-4222-8222-222222222222'::uuid
    and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
    and pairing_name = any(control_pairings);
  if not found then
    raise exception 'Approved control-pot irrigation event not found';
  end if;

  select jsonb_build_object(
    'irrigation_event_id', selected_event.id,
    'readings', coalesce((
      select jsonb_agg(to_jsonb(reading_row) order by reading_row.device_recorded_at,
        reading_row.event_id)
      from (
        select id, event_id, pairing_name, sensor_key, raw_value, calibrated_value,
               temperature, electrical_conductivity, device_recorded_at, server_received_at
        from public.sensor_readings
        where project_id = selected_event.project_id
          and device_id = selected_event.device_id
          and pairing_name = selected_event.pairing_name
          and event_id like 'live-device:%'
          and device_recorded_at >= selected_event.opened_device_at - interval '24 hours'
          and device_recorded_at <= selected_event.opened_device_at + interval '250 minutes'
        order by device_recorded_at, event_id
        limit 5000
      ) reading_row
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;


ALTER FUNCTION "public"."rd_atomic_event_observation_v4"("observation_irrigation_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_block_immutable_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  raise exception 'R&D scientific records are append-only';
end;
$$;


ALTER FUNCTION "public"."rd_block_immutable_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_enforce_committed_prediction_causality"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  prediction_record public.rd_curve_predictions%rowtype;
  first_open_at timestamptz;
begin
  if new.state <> 'committed' then
    return new;
  end if;
  first_open_at := nullif(new.details ->> 'irrigation_opened_device_at', '')::timestamptz;
  if first_open_at is null then
    raise exception 'Committed predictions require irrigation_opened_device_at';
  end if;
  select * into prediction_record
  from public.rd_curve_predictions
  where id = new.prediction_id;
  if not found
     or prediction_record.feature_as_of_device_at >= first_open_at
     or prediction_record.issued_at >= first_open_at then
    raise exception 'Prediction is not causal relative to first valve-open device time';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."rd_enforce_committed_prediction_causality"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_episode_observation_v3"("observation_episode_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  selected_episode public.rd_correction_episodes_v2%rowtype;
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may read an R&D episode observation';
  end if;
  select * into selected_episode
  from public.rd_correction_episodes_v2
  where id = observation_episode_id
    and project_id = '22222222-2222-4222-8222-222222222222'::uuid
    and device_id = '3100e37ee3205651fe3dd86dafd4dc0c';
  if not found then
    raise exception 'Approved R&D episode not found';
  end if;

  select jsonb_build_object(
    'episode_id', selected_episode.id,
    'readings', coalesce((
      select jsonb_agg(to_jsonb(reading_row) order by reading_row.device_recorded_at)
      from (
        select id, event_id, pairing_name, sensor_key, raw_value,
               calibrated_value, temperature, electrical_conductivity,
               device_recorded_at, server_received_at
        from public.sensor_readings
        where project_id = selected_episode.project_id
          and device_id = selected_episode.device_id
          and pairing_name = selected_episode.pairing_name
          and device_recorded_at >= selected_episode.first_open_device_at - interval '20 minutes'
          and device_recorded_at <= selected_episode.last_open_device_at + interval '250 minutes'
          and event_id like 'live-device:%'
        order by device_recorded_at
        limit 1000
      ) reading_row
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;


ALTER FUNCTION "public"."rd_episode_observation_v3"("observation_episode_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."rd_episode_observation_v3"("observation_episode_id" "uuid") IS 'Episode-local telemetry backfill that remains permanently scoped to Matt control-pot evidence.';



CREATE OR REPLACE FUNCTION "public"."rd_guard_model_status_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.status = 'champion'
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and current_setting('exacth2o.rd_promotion_context', true) <> 'authorized' then
    raise exception 'Champion status may only be assigned through promote_rd_model';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."rd_guard_model_status_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_promote_model_v2"("promote_project_id" "uuid", "promote_model_version_id" "uuid", "promote_evidence" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  previous_id uuid;
  qualified_windows integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may promote an R&D model';
  end if;

  perform pg_advisory_xact_lock(hashtext('exacth2o-rd-model-promotion-v2'));
  perform 1 from public.rd_model_versions
  where id = promote_model_version_id and status = 'candidate'
    and synthetic_data_only = false
  for update;
  if not found then
    raise exception 'Promotion candidate is missing or not eligible';
  end if;

  select count(*) into qualified_windows
  from public.rd_evaluation_windows_v2
  where model_version_id = promote_model_version_id and passed = true;
  if qualified_windows < 2 then
    raise exception 'Two qualified chronological windows are required';
  end if;

  select id into previous_id from public.rd_model_versions
  where status = 'champion' limit 1 for update;
  if previous_id is not null then
    update public.rd_model_versions set status = 'retired' where id = previous_id;
  end if;
  update public.rd_model_versions set status = 'champion'
  where id = promote_model_version_id;

  insert into public.rd_model_promotions (
    project_id, model_version_id, previous_model_version_id,
    decision, evidence, actor_id
  ) values (
    promote_project_id, promote_model_version_id, previous_id,
    'promoted', coalesce(promote_evidence, '{}'::jsonb), null
  );

  return jsonb_build_object(
    'promoted', true,
    'model_version_id', promote_model_version_id,
    'previous_model_version_id', previous_id
  );
end;
$$;


ALTER FUNCTION "public"."rd_promote_model_v2"("promote_project_id" "uuid", "promote_model_version_id" "uuid", "promote_evidence" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_promote_v5_shadow_candidate"("promote_project_id" "uuid", "promote_device_id" "text", "promote_model_version_id" "uuid", "promote_evidence" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  channel_record public.rd_shadow_model_channels_v5%rowtype;
  prior_champion uuid;
  next_candidate uuid;
  window_passes jsonb;
  candidate_created_at timestamptz;
  candidate_hash text;
  score_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may promote a V5 shadow model';
  end if;
  if coalesce((promote_evidence ->> 'future_finalized_events')::integer, 0) < 40
     or coalesce((promote_evidence ->> 'calendar_span_days')::double precision, 0) < 3
     or coalesce((promote_evidence ->> 'pot_count')::integer, 0) < 8
     or coalesce((promote_evidence ->> 'first_pulse_pot_count')::integer, 0) < 8
     or coalesce((promote_evidence ->> 'multi_pulse_events')::integer, 0) < 10
     or coalesce(
          (promote_evidence ->> 'multi_pulse_curve_mae')::double precision, 1e9
        ) > 0.85 * coalesce(
          (promote_evidence ->> 'multi_pulse_champion_curve_mae')::double precision, 0
        )
     or (
       coalesce((promote_evidence ->> 'single_pulse_events')::integer, 0) > 0
       and coalesce(
         (promote_evidence ->> 'single_pulse_curve_mae')::double precision, 1e9
       ) > 1.05 * coalesce(
         (promote_evidence ->> 'single_pulse_champion_curve_mae')::double precision, 0
       )
     )
     or coalesce((promote_evidence ->> 'per_pot_regression')::boolean, true)
     or coalesce((promote_evidence ->> 'interval_coverage')::double precision, 0) < 0.75
     or coalesce((promote_evidence ->> 'interval_coverage')::double precision, 1) > 0.90
     or coalesce((promote_evidence ->> 'candidate_curve_mae')::double precision, 1e9)
        > 0.90 * coalesce(
          (promote_evidence ->> 'champion_curve_mae')::double precision, 0
        ) then
    raise exception 'V5 future prequential promotion evidence is insufficient';
  end if;
  window_passes := promote_evidence -> 'two_window_passes';
  if jsonb_typeof(window_passes) <> 'array'
     or jsonb_array_length(window_passes) <> 2
     or window_passes <> '[true, true]'::jsonb then
    raise exception 'V5 requires two independently passing chronological windows';
  end if;

  lock table public.rd_prequential_scores_v5 in share row exclusive mode;
  select count(*) into score_count
  from public.rd_prequential_scores_v5
  where candidate_model_version_id = promote_model_version_id;
  if score_count <> coalesce(
    (promote_evidence ->> 'raw_candidate_score_rows')::integer, -1
  ) then
    raise exception 'V5 promotion evidence changed during decision';
  end if;

  perform pg_advisory_xact_lock(hashtext('exacth2o-rd-v5-shadow-promotion'));
  select * into channel_record
  from public.rd_shadow_model_channels_v5
  where project_id = promote_project_id and device_id = promote_device_id
  for update;
  if not found
     or channel_record.evaluation_candidate_model_version_id
        is distinct from promote_model_version_id then
    raise exception 'Requested model is not the pinned V5 evaluation candidate';
  end if;

  select created_at, artifact_sha256
  into candidate_created_at, candidate_hash
  from public.rd_model_versions
  where id = promote_model_version_id
    and feature_schema_version = 'atomic-response-v5'
    and synthetic_data_only = false;
  if not found then
    raise exception 'Pinned V5 evaluation candidate is not eligible';
  end if;

  prior_champion := channel_record.champion_model_version_id;
  next_candidate := null;
  if channel_record.latest_challenger_model_version_id
     is distinct from promote_model_version_id then
    select id into next_candidate
    from public.rd_model_versions
    where id = channel_record.latest_challenger_model_version_id
      and id is distinct from prior_champion
      and status = 'candidate'
      and feature_schema_version = 'atomic-response-v5'
      and synthetic_data_only = false
      and created_at > candidate_created_at
      and artifact_sha256 is distinct from candidate_hash;
  end if;

  update public.rd_shadow_model_channels_v5
  set champion_model_version_id = promote_model_version_id,
      champion_since = now(),
      evaluation_candidate_model_version_id = next_candidate,
      evaluation_started_at = case when next_candidate is null then null else now() end,
      updated_at = now()
  where project_id = promote_project_id and device_id = promote_device_id;

  insert into public.rd_shadow_model_channel_events_v5 (
    project_id, device_id, event_type, model_version_id,
    previous_model_version_id, evidence
  ) values (
    promote_project_id, promote_device_id, 'shadow_promoted',
    promote_model_version_id, prior_champion, promote_evidence
  );
  if next_candidate is not null then
    insert into public.rd_shadow_model_channel_events_v5 (
      project_id, device_id, event_type, model_version_id,
      previous_model_version_id, evidence
    ) values (
      promote_project_id, promote_device_id, 'evaluation_bound',
      next_candidate, promote_model_version_id,
      jsonb_build_object(
        'reason', 'newer_challenger_bound_after_shadow_promotion',
        'evaluation_clock_reset', true,
        'shadow_only', true,
        'control_access', 'none'
      )
    );
  end if;
  return jsonb_build_object(
    'promoted', true,
    'previous_champion_model_version_id', prior_champion,
    'champion_model_version_id', promote_model_version_id,
    'evaluation_candidate_model_version_id', next_candidate,
    'shadow_only', true,
    'control_access', 'none'
  );
end;
$$;


ALTER FUNCTION "public"."rd_promote_v5_shadow_candidate"("promote_project_id" "uuid", "promote_device_id" "text", "promote_model_version_id" "uuid", "promote_evidence" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_publish_provisional_model_v4"("publish_version" "text", "publish_artifact_path" "text", "publish_artifact_sha256" "text", "publish_evidence_fingerprint" "text", "publish_training_event_count" integer, "publish_training_horizon_count" integer, "publish_metrics" "jsonb", "publish_parameters" "jsonb", "publish_code_commit" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  existing_model_id uuid;
  previous_model_id uuid;
  created_model_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may publish a provisional R&D model';
  end if;
  if publish_artifact_path not like 'gs://%'
     or publish_training_event_count < 1
     or publish_training_horizon_count < 1 then
    raise exception 'Invalid provisional model evidence or artifact';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('exacth2o:atomic-response-v4:publish', 0));
  select id into existing_model_id
  from public.rd_model_versions
  where feature_schema_version = 'atomic-response-v4'
    and training_dataset_hash = publish_evidence_fingerprint
  order by created_at desc
  limit 1;
  if existing_model_id is not null then
    return jsonb_build_object(
      'published', false, 'reason', 'evidence_already_published',
      'model_version_id', existing_model_id
    );
  end if;

  select id into previous_model_id
  from public.rd_model_versions
  where feature_schema_version = 'atomic-response-v4'
    and status in ('candidate', 'champion')
  order by created_at desc
  limit 1
  for update;

  update public.rd_model_versions
  set status = 'retired'
  where feature_schema_version = 'atomic-response-v4' and status = 'candidate';

  insert into public.rd_model_versions (
    version, status, artifact_path, artifact_sha256, feature_schema_version,
    training_dataset_hash, training_event_count, metrics, synthetic_data_only
  ) values (
    publish_version, 'candidate', publish_artifact_path, publish_artifact_sha256,
    'atomic-response-v4', publish_evidence_fingerprint, publish_training_event_count,
    coalesce(publish_metrics, '{}'::jsonb) || jsonb_build_object(
      'role', 'provisional_living_model', 'shadow_only', true, 'control_access', 'none'
    ), false
  ) returning id into created_model_id;

  insert into public.rd_training_runs (
    model_version_id, code_commit, dataset_hash, parameters, training_event_count,
    held_out_event_count, result, metrics, completed_at
  ) values (
    created_model_id, publish_code_commit, publish_evidence_fingerprint,
    coalesce(publish_parameters, '{}'::jsonb), publish_training_event_count,
    coalesce((publish_metrics ->> 'held_out_event_count')::integer, 0),
    'succeeded', coalesce(publish_metrics, '{}'::jsonb), now()
  );

  insert into public.rd_model_updates_v4 (
    model_version_id, previous_model_version_id, evidence_fingerprint,
    training_event_count, training_horizon_count, artifact_path, artifact_sha256,
    code_commit, metrics
  ) values (
    created_model_id, previous_model_id, publish_evidence_fingerprint,
    publish_training_event_count, publish_training_horizon_count,
    publish_artifact_path, publish_artifact_sha256, publish_code_commit,
    coalesce(publish_metrics, '{}'::jsonb)
  );

  return jsonb_build_object(
    'published', true, 'model_version_id', created_model_id,
    'previous_model_version_id', previous_model_id
  );
end;
$$;


ALTER FUNCTION "public"."rd_publish_provisional_model_v4"("publish_version" "text", "publish_artifact_path" "text", "publish_artifact_sha256" "text", "publish_evidence_fingerprint" "text", "publish_training_event_count" integer, "publish_training_horizon_count" integer, "publish_metrics" "jsonb", "publish_parameters" "jsonb", "publish_code_commit" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_publish_v5_challenger"("publish_version" "text", "publish_artifact_path" "text", "publish_artifact_sha256" "text", "publish_evidence_fingerprint" "text", "publish_training_event_count" integer, "publish_training_horizon_count" integer, "publish_metrics" "jsonb", "publish_parameters" "jsonb", "publish_dataset_manifest" "jsonb", "publish_code_commit" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  prior_model_id uuid;
  created_model_id uuid;
  existing_model_id uuid;
  channel_record public.rd_shadow_model_channels_v5%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may publish private V5 challengers';
  end if;
  if publish_training_event_count < 40 or publish_training_horizon_count < 120 then
    raise exception 'V5 finalized-evidence readiness gate failed';
  end if;
  if jsonb_typeof(publish_dataset_manifest) <> 'array'
     or jsonb_array_length(publish_dataset_manifest) <> publish_training_event_count then
    raise exception 'V5 dataset manifest must identify every finalized training event';
  end if;
  if publish_code_commit = 'unknown' or length(publish_code_commit) < 7 then
    raise exception 'V5 publication requires a traceable code commit';
  end if;

  perform pg_advisory_xact_lock(hashtext('exacth2o-rd-v5-publication'));
  select model_version_id into existing_model_id
  from public.rd_model_updates_v5
  where evidence_fingerprint = publish_evidence_fingerprint;
  if found then
    select * into channel_record
    from public.rd_shadow_model_channels_v5
    where project_id = '22222222-2222-4222-8222-222222222222'::uuid
      and device_id = '3100e37ee3205651fe3dd86dafd4dc0c';
    return jsonb_build_object(
      'published', false,
      'model_version_id', existing_model_id,
      'champion_model_version_id', channel_record.champion_model_version_id,
      'evaluation_candidate_model_version_id',
        channel_record.evaluation_candidate_model_version_id
    );
  end if;

  select model_version_id into prior_model_id
  from public.rd_model_updates_v5 order by created_at desc limit 1;
  insert into public.rd_model_versions (
    version, status, artifact_path, artifact_sha256, feature_schema_version,
    training_dataset_hash, training_event_count, metrics, synthetic_data_only
  ) values (
    publish_version, 'candidate', publish_artifact_path, publish_artifact_sha256,
    'atomic-response-v5', publish_evidence_fingerprint,
    publish_training_event_count, publish_metrics, false
  ) returning id into created_model_id;
  insert into public.rd_model_updates_v5 (
    model_version_id, previous_model_version_id, evidence_fingerprint,
    training_event_count, training_horizon_count, dataset_manifest,
    artifact_path, artifact_sha256, code_commit, parameters, metrics
  ) values (
    created_model_id, prior_model_id, publish_evidence_fingerprint,
    publish_training_event_count, publish_training_horizon_count,
    publish_dataset_manifest, publish_artifact_path, publish_artifact_sha256,
    publish_code_commit, publish_parameters, publish_metrics
  );

  select * into channel_record
  from public.rd_shadow_model_channels_v5
  where project_id = '22222222-2222-4222-8222-222222222222'::uuid
    and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
  for update;
  if not found then
    raise exception 'V5 shadow channel was not initialized with a V4 champion';
  end if;
  update public.rd_shadow_model_channels_v5
  set latest_challenger_model_version_id = created_model_id,
      evaluation_candidate_model_version_id = coalesce(
        evaluation_candidate_model_version_id, created_model_id
      ),
      evaluation_started_at = case
        when evaluation_candidate_model_version_id is null then now()
        else evaluation_started_at
      end,
      updated_at = now()
  where project_id = channel_record.project_id and device_id = channel_record.device_id
  returning * into channel_record;
  insert into public.rd_shadow_model_channel_events_v5 (
    project_id, device_id, event_type, model_version_id,
    previous_model_version_id, evidence
  ) values (
    channel_record.project_id, channel_record.device_id, 'challenger_published',
    created_model_id, prior_model_id,
    jsonb_build_object(
      'evidence_fingerprint', publish_evidence_fingerprint,
      'training_event_count', publish_training_event_count,
      'shadow_only', true,
      'control_access', 'none'
    )
  );
  return jsonb_build_object(
    'published', true,
    'model_version_id', created_model_id,
    'champion_model_version_id', channel_record.champion_model_version_id,
    'evaluation_candidate_model_version_id',
      channel_record.evaluation_candidate_model_version_id
  );
end;
$$;


ALTER FUNCTION "public"."rd_publish_v5_challenger"("publish_version" "text", "publish_artifact_path" "text", "publish_artifact_sha256" "text", "publish_evidence_fingerprint" "text", "publish_training_event_count" integer, "publish_training_horizon_count" integer, "publish_metrics" "jsonb", "publish_parameters" "jsonb", "publish_dataset_manifest" "jsonb", "publish_code_commit" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_record_irrigation_event_v2"("record_project_id" "uuid", "record_device_id" "text", "record_pairing_name" "text", "record_valve_event_id" "text", "record_opened_device_at" timestamp with time zone, "record_duration_ms" integer, "record_duration_source" "text", "record_source_class" "text", "record_evidence_source" "text", "record_prediction_id" "uuid", "record_prediction_lead_seconds" integer, "record_target_vwc" double precision, "record_config_hash" "text", "record_quality" "jsonb", "record_settle_gap_minutes" integer DEFAULT 45) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  existing_event public.rd_irrigation_events_v2%rowtype;
  selected_episode public.rd_correction_episodes_v2%rowtype;
  event_sequence integer;
  created_event_id uuid;
  stable_episode_key text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may record R&D irrigation events';
  end if;
  if record_source_class <> 'automatic' then
    raise exception 'Only confirmed automatic events are eligible for the R&D stream';
  end if;

  select * into existing_event
  from public.rd_irrigation_events_v2
  where project_id = record_project_id
    and device_id = record_device_id
    and valve_event_id = record_valve_event_id;
  if found then
    return jsonb_build_object(
      'event_id', existing_event.id,
      'episode_id', existing_event.episode_id,
      'created', false
    );
  end if;

  select * into selected_episode
  from public.rd_correction_episodes_v2
  where project_id = record_project_id
    and device_id = record_device_id
    and pairing_name = record_pairing_name
    and first_open_device_at <= record_opened_device_at
    and last_open_device_at >= record_opened_device_at
      - make_interval(mins => greatest(1, record_settle_gap_minutes))
  order by last_open_device_at desc
  limit 1
  for update;

  if not found then
    stable_episode_key := encode(
      extensions.digest(
        record_project_id::text || '|' || record_device_id || '|' ||
        record_pairing_name || '|' || record_valve_event_id || '|' || record_config_hash,
        'sha256'
      ),
      'hex'
    );
    insert into public.rd_correction_episodes_v2 (
      episode_key, project_id, device_id, pairing_name,
      first_open_event_id, first_open_device_at, last_open_device_at,
      target_vwc_at_start, config_hash_at_start, pulse_count, status,
      observation_ends_at, quality
    ) values (
      stable_episode_key, record_project_id, record_device_id, record_pairing_name,
      record_valve_event_id, record_opened_device_at, record_opened_device_at,
      record_target_vwc, record_config_hash, 0, 'active',
      record_opened_device_at + interval '240 minutes',
      jsonb_build_object('shadow_only', true)
    ) returning * into selected_episode;
  end if;

  event_sequence := selected_episode.pulse_count + 1;
  insert into public.rd_irrigation_events_v2 (
    project_id, device_id, pairing_name, valve_event_id, episode_id,
    sequence_in_episode, prediction_id, prediction_status,
    opened_device_at, duration_ms, duration_source, source_class,
    evidence_source, prediction_lead_seconds, quality
  ) values (
    record_project_id, record_device_id, record_pairing_name,
    record_valve_event_id, selected_episode.id, event_sequence,
    record_prediction_id,
    case when record_prediction_id is null then 'missed_causal_window' else 'committed' end,
    record_opened_device_at, record_duration_ms, record_duration_source,
    record_source_class, record_evidence_source, record_prediction_lead_seconds,
    coalesce(record_quality, '{}'::jsonb)
  ) returning id into created_event_id;

  update public.rd_correction_episodes_v2
  set last_open_device_at = greatest(last_open_device_at, record_opened_device_at),
      pulse_count = event_sequence,
      status = 'active',
      correction_ended_at = null,
      observation_ends_at = greatest(
        observation_ends_at,
        record_opened_device_at + interval '240 minutes'
      ),
      completed_at = null,
      updated_at = now()
  where id = selected_episode.id;

  return jsonb_build_object(
    'event_id', created_event_id,
    'episode_id', selected_episode.id,
    'created', true
  );
end;
$$;


ALTER FUNCTION "public"."rd_record_irrigation_event_v2"("record_project_id" "uuid", "record_device_id" "text", "record_pairing_name" "text", "record_valve_event_id" "text", "record_opened_device_at" timestamp with time zone, "record_duration_ms" integer, "record_duration_source" "text", "record_source_class" "text", "record_evidence_source" "text", "record_prediction_id" "uuid", "record_prediction_lead_seconds" integer, "record_target_vwc" double precision, "record_config_hash" "text", "record_quality" "jsonb", "record_settle_gap_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_refresh_episode_states_v2"("reference_at" timestamp with time zone DEFAULT "now"(), "settle_gap_minutes" integer DEFAULT 45) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  changed integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may refresh R&D episode states';
  end if;
  update public.rd_correction_episodes_v2
  set status = case
        when reference_at < last_open_device_at
          + make_interval(mins => greatest(1, settle_gap_minutes)) then 'active'
        when reference_at < observation_ends_at then 'observing'
        else 'complete'
      end,
      correction_ended_at = case
        when reference_at >= last_open_device_at
          + make_interval(mins => greatest(1, settle_gap_minutes))
        then last_open_device_at
          + make_interval(mins => greatest(1, settle_gap_minutes))
        else null
      end,
      completed_at = case
        when reference_at >= observation_ends_at then coalesce(completed_at, reference_at)
        else null
      end,
      updated_at = now()
  where status is distinct from case
        when reference_at < last_open_device_at
          + make_interval(mins => greatest(1, settle_gap_minutes)) then 'active'
        when reference_at < observation_ends_at then 'observing'
        else 'complete'
      end
     or (reference_at >= observation_ends_at and completed_at is null);
  get diagnostics changed = row_count;
  return changed;
end;
$$;


ALTER FUNCTION "public"."rd_refresh_episode_states_v2"("reference_at" timestamp with time zone, "settle_gap_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_reject_and_advance_v5_shadow_candidate"("reject_project_id" "uuid", "reject_device_id" "text", "reject_model_version_id" "uuid", "reject_expected_evaluation_started_at" timestamp with time zone, "reject_evidence" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  channel_record public.rd_shadow_model_channels_v5%rowtype;
  candidate_created_at timestamptz;
  candidate_hash text;
  successor_id uuid;
  score_count integer;
  window_passes jsonb;
  is_promotable boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may reject private V5 challengers';
  end if;
  if coalesce((reject_evidence ->> 'future_finalized_events')::integer, 0) < 40
     or coalesce((reject_evidence ->> 'calendar_span_days')::double precision, 0) < 3
     or coalesce((reject_evidence ->> 'pot_count')::integer, 0) < 8
     or coalesce((reject_evidence ->> 'first_pulse_pot_count')::integer, 0) < 8
     or coalesce((reject_evidence ->> 'multi_pulse_events')::integer, 0) < 10 then
    raise exception 'V5 candidate is not mature enough for rejection';
  end if;

  window_passes := reject_evidence -> 'two_window_passes';
  is_promotable :=
    window_passes = '[true, true]'::jsonb
    and coalesce((reject_evidence ->> 'interval_coverage')::double precision, 0)
      between 0.75 and 0.90
    and not coalesce((reject_evidence ->> 'per_pot_regression')::boolean, true)
    and coalesce(
      (reject_evidence ->> 'candidate_curve_mae')::double precision, 1e9
    ) <= 0.90 * coalesce(
      (reject_evidence ->> 'champion_curve_mae')::double precision, 0
    )
    and coalesce(
      (reject_evidence ->> 'multi_pulse_curve_mae')::double precision, 1e9
    ) <= 0.85 * coalesce(
      (reject_evidence ->> 'multi_pulse_champion_curve_mae')::double precision, 0
    )
    and (
      coalesce((reject_evidence ->> 'single_pulse_events')::integer, 0) = 0
      or coalesce(
        (reject_evidence ->> 'single_pulse_curve_mae')::double precision, 1e9
      ) <= 1.05 * coalesce(
        (reject_evidence ->> 'single_pulse_champion_curve_mae')::double precision, 0
      )
    );
  if is_promotable then
    raise exception 'Refusing to reject a promotable V5 candidate';
  end if;

  lock table public.rd_prequential_scores_v5 in share row exclusive mode;
  perform pg_advisory_xact_lock(hashtext('exacth2o-rd-v5-shadow-promotion'));
  select * into channel_record
  from public.rd_shadow_model_channels_v5
  where project_id = reject_project_id and device_id = reject_device_id
  for update;
  if not found
     or channel_record.evaluation_candidate_model_version_id
        is distinct from reject_model_version_id
     or channel_record.evaluation_started_at
        is distinct from reject_expected_evaluation_started_at then
    return jsonb_build_object('advanced', false, 'reason', 'stale_evaluation_binding');
  end if;

  select count(*) into score_count
  from public.rd_prequential_scores_v5
  where candidate_model_version_id = reject_model_version_id;
  if score_count <> coalesce(
    (reject_evidence ->> 'raw_candidate_score_rows')::integer, -1
  ) then
    return jsonb_build_object('advanced', false, 'reason', 'evaluation_evidence_changed');
  end if;

  select created_at, artifact_sha256
  into candidate_created_at, candidate_hash
  from public.rd_model_versions
  where id = reject_model_version_id
    and status = 'candidate'
    and feature_schema_version = 'atomic-response-v5'
    and synthetic_data_only = false;
  if not found then
    return jsonb_build_object('advanced', false, 'reason', 'candidate_not_rejectable');
  end if;

  successor_id := null;
  select id into successor_id
  from public.rd_model_versions
  where id = channel_record.latest_challenger_model_version_id
    and id is distinct from reject_model_version_id
    and id is distinct from channel_record.champion_model_version_id
    and status = 'candidate'
    and feature_schema_version = 'atomic-response-v5'
    and synthetic_data_only = false
    and created_at > candidate_created_at
    and artifact_sha256 is distinct from candidate_hash;
  if successor_id is null then
    return jsonb_build_object('advanced', false, 'reason', 'no_eligible_newer_challenger');
  end if;

  update public.rd_model_versions
  set status = 'retired'
  where id = reject_model_version_id and status = 'candidate';
  update public.rd_shadow_model_channels_v5
  set evaluation_candidate_model_version_id = successor_id,
      evaluation_started_at = now(),
      updated_at = now()
  where project_id = reject_project_id and device_id = reject_device_id;

  insert into public.rd_shadow_model_channel_events_v5 (
    project_id, device_id, event_type, model_version_id,
    previous_model_version_id, evidence
  ) values (
    reject_project_id, reject_device_id, 'candidate_rejected',
    reject_model_version_id, channel_record.champion_model_version_id,
    reject_evidence || jsonb_build_object(
      'successor_model_version_id', successor_id,
      'evaluation_policy', 'expanding_window_until_newer_challenger',
      'shadow_only', true,
      'control_access', 'none'
    )
  );
  insert into public.rd_shadow_model_channel_events_v5 (
    project_id, device_id, event_type, model_version_id,
    previous_model_version_id, evidence
  ) values (
    reject_project_id, reject_device_id, 'evaluation_bound',
    successor_id, reject_model_version_id,
    jsonb_build_object(
      'reason', 'newer_challenger_bound_after_mature_rejection',
      'evaluation_clock_reset', true,
      'shadow_only', true,
      'control_access', 'none'
    )
  );
  return jsonb_build_object(
    'advanced', true,
    'rejected_model_version_id', reject_model_version_id,
    'evaluation_candidate_model_version_id', successor_id,
    'champion_model_version_id', channel_record.champion_model_version_id,
    'shadow_only', true,
    'control_access', 'none'
  );
end;
$$;


ALTER FUNCTION "public"."rd_reject_and_advance_v5_shadow_candidate"("reject_project_id" "uuid", "reject_device_id" "text", "reject_model_version_id" "uuid", "reject_expected_evaluation_started_at" timestamp with time zone, "reject_evidence" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rd_training_evidence_page_v4"("evidence_kind" "text", "cursor_device_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "cursor_event_id" "text" DEFAULT ''::"text", "page_limit" integer DEFAULT 500) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  result jsonb;
  bounded_limit integer := greatest(1, least(coalesce(page_limit, 500), 500));
  control_pairings constant text[] := array[
    'Zone2-Pot41', 'Zone2-Pot43', 'Zone2-Pot45', 'Zone2-Pot47', 'Zone2-Pot49',
    'Zone4-Pot91', 'Zone4-Pot93', 'Zone4-Pot95', 'Zone4-Pot97', 'Zone4-Pot99'
  ];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may page private R&D evidence';
  end if;
  if evidence_kind not in ('reading', 'valve_open') then
    raise exception 'Unsupported R&D evidence kind';
  end if;

  if evidence_kind = 'reading' then
    select coalesce(jsonb_agg(to_jsonb(selected) order by selected.device_recorded_at,
      selected.event_id), '[]'::jsonb)
    into result
    from (
      select id, event_id, pairing_name, sensor_key, raw_value, calibrated_value,
             temperature, electrical_conductivity, device_recorded_at, server_received_at
      from public.sensor_readings
      where project_id = '22222222-2222-4222-8222-222222222222'::uuid
        and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
        and pairing_name = any(control_pairings)
        and event_id like 'live-device:%'
        and (
          cursor_device_at is null
          or device_recorded_at > cursor_device_at
          or (device_recorded_at = cursor_device_at and event_id > cursor_event_id)
        )
      order by device_recorded_at, event_id
      limit bounded_limit
    ) selected;
  else
    select coalesce(jsonb_agg(to_jsonb(selected) order by selected.device_recorded_at,
      selected.event_id), '[]'::jsonb)
    into result
    from (
      select event_id, pairing_name, action, duration_ms, device_recorded_at,
             server_received_at, evidence_source, source_class, pairing_resolved,
             quality_flags
      from public.valve_events
      where project_id = '22222222-2222-4222-8222-222222222222'::uuid
        and device_id = '3100e37ee3205651fe3dd86dafd4dc0c'
        and pairing_name = any(control_pairings)
        and action = 'open'
        and source_class = 'automatic'
        and pairing_resolved = true
        and (
          cursor_device_at is null
          or device_recorded_at > cursor_device_at
          or (device_recorded_at = cursor_device_at and event_id > cursor_event_id)
        )
      order by device_recorded_at, event_id
      limit bounded_limit
    ) selected;
  end if;
  return result;
end;
$$;


ALTER FUNCTION "public"."rd_training_evidence_page_v4"("evidence_kind" "text", "cursor_device_at" timestamp with time zone, "cursor_event_id" "text", "page_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."rd_training_evidence_page_v4"("evidence_kind" "text", "cursor_device_at" timestamp with time zone, "cursor_event_id" "text", "page_limit" integer) IS 'Deterministic keyset page over Matt control-pot evidence. Read-only and service-role only.';



CREATE OR REPLACE FUNCTION "public"."rd_worker_observation"("observation_project_id" "uuid", "observation_device_id" "text", "observation_since" timestamp with time zone DEFAULT ("now"() - '36:00:00'::interval)) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  matt_project_id constant uuid := '22222222-2222-4222-8222-222222222222'::uuid;
  matt_device_id constant text := '3100e37ee3205651fe3dd86dafd4dc0c';
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may read the R&D worker observation';
  end if;
  if observation_project_id <> matt_project_id or observation_device_id <> matt_device_id then
    raise exception 'R&D observation is scoped to the approved shadow experiment';
  end if;
  if observation_since < now() - interval '8 days' then
    raise exception 'R&D observation window is too large';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'config', (
      select to_jsonb(config_row)
      from (
        select project_id, device_id, observed_at, pairings, calibrations,
               board_config, groups, config_hash, updated_at
        from public.device_config_state
        where project_id = matt_project_id and device_id = matt_device_id
        limit 1
      ) config_row
    ),
    'readings', coalesce((
      select jsonb_agg(to_jsonb(reading_row) order by reading_row.device_recorded_at)
      from (
        select id, event_id, pairing_name, sensor_key, raw_value,
               calibrated_value, temperature, electrical_conductivity,
               device_recorded_at, server_received_at
        from public.sensor_readings
        where project_id = matt_project_id
          and device_id = matt_device_id
          and device_recorded_at >= observation_since
          and event_id like 'live-device:%'
        order by device_recorded_at desc
        limit 12000
      ) reading_row
    ), '[]'::jsonb),
    'valve_events', coalesce((
      select jsonb_agg(to_jsonb(valve_row) order by valve_row.device_recorded_at)
      from (
        select event_id, pairing_name, action, duration_ms,
               device_recorded_at, server_received_at, evidence_source,
               source_class, pairing_resolved, quality_flags
        from public.valve_events
        where project_id = matt_project_id
          and device_id = matt_device_id
          and device_recorded_at >= observation_since
          and source_class = 'automatic'
          and pairing_resolved = true
        order by device_recorded_at desc
        limit 2000
      ) valve_row
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;


ALTER FUNCTION "public"."rd_worker_observation"("observation_project_id" "uuid", "observation_device_id" "text", "observation_since" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."rd_worker_observation"("observation_project_id" "uuid", "observation_device_id" "text", "observation_since" timestamp with time zone) IS 'Read-only, Matt-scoped telemetry DTO for the private shadow ML worker.';



CREATE OR REPLACE FUNCTION "public"."rd_worker_predictions_v3"("observation_project_id" "uuid", "recent_since" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may read R&D prediction state';
  end if;
  if observation_project_id <> '22222222-2222-4222-8222-222222222222'::uuid then
    raise exception 'R&D prediction state is scoped to the approved experiment';
  end if;
  if recent_since < now() - interval '8 days' then
    raise exception 'R&D prediction window is too large';
  end if;

  with latest as (
    select distinct on (event.prediction_id)
      event.prediction_id, event.state, event.occurred_at
    from public.rd_prediction_events event
    order by event.prediction_id, event.occurred_at desc
  ), selected as (
    select prediction.id, prediction.prediction_key, prediction.pairing_name,
           prediction.model_version_id, prediction.band, prediction.trigger_vwc,
           prediction.target_vwc_at_issue, prediction.configured_valve_open_ms,
           prediction.measurement_interval_ms, prediction.calibration_version,
           prediction.config_hash, prediction.feature_as_of_device_at,
           prediction.issued_at, prediction.p10, prediction.p50, prediction.p90,
           latest.state as latest_state, latest.occurred_at as latest_state_at
    from public.rd_curve_predictions prediction
    left join latest on latest.prediction_id = prediction.id
    where prediction.project_id = observation_project_id
      and (
        prediction.issued_at >= recent_since
        or latest.state in ('armed_early', 'armed_refresh')
      )
    order by prediction.issued_at desc, prediction.id desc
  )
  select coalesce(jsonb_agg(to_jsonb(selected)), '[]'::jsonb)
  into result from selected;
  return result;
end;
$$;


ALTER FUNCTION "public"."rd_worker_predictions_v3"("observation_project_id" "uuid", "recent_since" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_device_control_quarantine"("reconcile_project_id" "uuid", "reconcile_device_id" "text", "observed_at" timestamp with time zone, "confirmed_valves_closed" boolean, "observed_state" "jsonb", "reconciliation_note" "text", "reenable_commands" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  enabled_count integer := 0;
  canceled_count integer := 0;
  safe_device_id text := trim(coalesce(reconcile_device_id, ''));
  safe_note text := left(trim(coalesce(reconciliation_note, '')), 1000);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may reconcile a quarantined device';
  end if;

  if safe_device_id = '' then
    raise exception 'A device ID is required';
  end if;

  if observed_at is null or observed_at < now() - interval '5 minutes' or observed_at > now() + interval '1 minute' then
    raise exception 'A fresh device observation is required';
  end if;

  if confirmed_valves_closed is not true then
    raise exception 'All valves must be independently confirmed closed';
  end if;

  if jsonb_typeof(coalesce(observed_state, '{}'::jsonb)) <> 'object' then
    raise exception 'Observed state must be a JSON object';
  end if;

  if upper(coalesce(observed_state->>'controller_state', '')) <> 'STOPPED' then
    raise exception 'Observed controller state must be STOPPED';
  end if;

  if length(trim(coalesce(observed_state->>'verification', ''))) < 5 then
    raise exception 'Observed state must include independent verification evidence';
  end if;

  if length(safe_note) < 10 then
    raise exception 'A reconciliation note is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(reconcile_project_id::text || ':' || safe_device_id, 0)
  );

  if not exists (
    select 1
    from public.device_control_quarantines quarantine
    where quarantine.project_id = reconcile_project_id
      and quarantine.device_id = safe_device_id
      and quarantine.active = true
  ) then
    raise exception 'Device command stream is not actively quarantined';
  end if;

  if exists (
    select 1
    from public.project_control_commands pcc
    where pcc.project_id = reconcile_project_id
      and pcc.device_id = safe_device_id
      and pcc.status = 'running'
  ) then
    raise exception 'A running command still exists for this device';
  end if;

  insert into public.project_control_audit (
    project_id,
    device_id,
    action,
    status,
    details
  ) values (
    reconcile_project_id,
    safe_device_id,
    'device_reconcile',
    case when reenable_commands then 'reenabled' else 'verified' end,
    jsonb_build_object(
      'observed_at', observed_at,
      'confirmed_valves_closed', confirmed_valves_closed,
      'observed_state', coalesce(observed_state, '{}'::jsonb),
      'note', safe_note,
      'reenable_commands', reenable_commands
    )
  );

  update public.device_control_quarantines quarantine
  set active = not reenable_commands,
      reconciled_at = case when reenable_commands then now() else null end,
      reconciliation_details = jsonb_build_object(
        'observed_at', observed_at,
        'confirmed_valves_closed', confirmed_valves_closed,
        'observed_state', coalesce(observed_state, '{}'::jsonb),
        'note', safe_note,
        'reenable_commands', reenable_commands
      )
  where quarantine.project_id = reconcile_project_id
    and quarantine.device_id = safe_device_id
    and quarantine.active = true;

  if reenable_commands then
    with canceled as (
      update public.project_control_commands pcc
      set status = 'canceled',
          completed_at = now(),
          lease_expires_at = null,
          error = 'Canceled during device reconciliation; resubmit after verification'
      where pcc.project_id = reconcile_project_id
        and pcc.device_id = safe_device_id
        and pcc.status in ('queued', 'accepted')
      returning pcc.id, pcc.project_id, pcc.device_id
    ), audited as (
      insert into public.project_control_audit (
        command_id,
        project_id,
        device_id,
        action,
        status,
        details
      )
      select
        canceled.id,
        canceled.project_id,
        canceled.device_id,
        'device_reconcile_cancel_pending',
        'canceled',
        jsonb_build_object('requires_resubmission', true)
      from canceled
      returning 1
    )
    select count(*) into canceled_count from audited;

    update public.device_control_tokens dct
    set enabled = true,
        disabled_at = null,
        disabled_reason = null
    where dct.project_id = reconcile_project_id
      and dct.device_id = safe_device_id
      and dct.revoked_at is null
      and dct.enabled = false
      and dct.disabled_reason in ('command_quarantine', 'command_lease_expired');
    get diagnostics enabled_count = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'reenabled', reenable_commands,
    'enabled_token_count', enabled_count,
    'canceled_pending_count', canceled_count
  );
end;
$$;


ALTER FUNCTION "public"."reconcile_device_control_quarantine"("reconcile_project_id" "uuid", "reconcile_device_id" "text", "observed_at" timestamp with time zone, "confirmed_valves_closed" boolean, "observed_state" "jsonb", "reconciliation_note" "text", "reenable_commands" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_experiment_control_command"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."reconcile_experiment_control_command"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_experiment_control_plan"("requested_plan_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."reconcile_experiment_control_plan"("requested_plan_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_device_ingest_lease"("lease_project_id" "uuid", "lease_device_id" "text", "lease_holder" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  changed_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may release ingest leases';
  end if;

  delete from public.device_ingest_leases
  where project_id = lease_project_id
    and device_id = trim(lease_device_id)
    and holder = lease_holder;

  get diagnostics changed_count = row_count;
  return changed_count = 1;
end;
$$;


ALTER FUNCTION "public"."release_device_ingest_lease"("lease_project_id" "uuid", "lease_device_id" "text", "lease_holder" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."restore_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") RETURNS TABLE("experiment_id" "uuid", "experiment_slug" "text", "experiment_status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."restore_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_device_health_retention"("retention_days" integer DEFAULT 30, "minimum_interval_hours" integer DEFAULT 23) RETURNS TABLE("ran" boolean, "deleted_rows" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  last_completed timestamptz;
  deleted_count integer := 0;
  safe_interval integer := least(greatest(minimum_interval_hours, 1), 168);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may run device health retention';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('device-health-retention', 0));

  select state.last_completed_at
  into last_completed
  from public.device_maintenance_state state
  where state.task_name = 'device_health_retention';

  if last_completed is not null
     and last_completed > now() - make_interval(hours => safe_interval) then
    return query select false, 0;
    return;
  end if;

  insert into public.device_maintenance_state (task_name, last_started_at)
  values ('device_health_retention', now())
  on conflict (task_name) do update
  set last_started_at = excluded.last_started_at;

  deleted_count := public.prune_device_health_history(retention_days);

  update public.device_maintenance_state
  set last_completed_at = now(),
      details = jsonb_build_object(
        'retention_days', least(greatest(retention_days, 1), 365),
        'deleted_rows', deleted_count
      )
  where task_name = 'device_health_retention';

  return query select true, deleted_count;
end;
$$;


ALTER FUNCTION "public"."run_device_health_retention"("retention_days" integer, "minimum_interval_hours" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_public_quote_submission"("submission_data" "jsonb", "submission_fingerprint_value" "text", "notification_recipient" "text") RETURNS TABLE("request_id" "uuid", "duplicate" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  created_quote_id uuid;
  created_thread_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may save public quote submissions';
  end if;

  if jsonb_typeof(coalesce(submission_data, '{}'::jsonb)) <> 'object'
     or length(coalesce(submission_fingerprint_value, '')) < 32 then
    raise exception 'Invalid quote submission input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('public-quote:' || submission_fingerprint_value, 0));

  select quote.id
  into created_quote_id
  from public.quote_requests quote
  where quote.submission_fingerprint = submission_fingerprint_value
    and quote.created_at > now() - interval '15 minutes'
  order by quote.created_at desc
  limit 1;

  if created_quote_id is not null then
    return query select created_quote_id, true;
    return;
  end if;

  insert into public.quote_requests (
    project_id,
    name,
    email,
    phone,
    organization,
    application,
    timeline,
    message,
    source_url,
    referrer,
    origin,
    user_agent,
    notification_email,
    notification_status,
    status,
    priority,
    submission_fingerprint
  ) values (
    (submission_data->>'project_id')::uuid,
    submission_data->>'name',
    submission_data->>'email',
    nullif(submission_data->>'phone', ''),
    nullif(submission_data->>'organization', ''),
    submission_data->>'application',
    nullif(submission_data->>'timeline', ''),
    submission_data->>'message',
    nullif(submission_data->>'source_url', ''),
    nullif(submission_data->>'referrer', ''),
    nullif(submission_data->>'origin', ''),
    nullif(submission_data->>'user_agent', ''),
    notification_recipient,
    'pending',
    'new',
    'normal',
    submission_fingerprint_value
  )
  returning id into created_quote_id;

  insert into public.support_threads (
    project_id,
    source,
    status,
    priority,
    request_type,
    submission_fingerprint,
    subject,
    customer_name,
    customer_email,
    customer_phone,
    customer_organization,
    quote_request_id,
    metadata
  ) values (
    (submission_data->>'project_id')::uuid,
    'quote',
    'new',
    'normal',
    'quote',
    submission_fingerprint_value,
    'Quote request: ' || (submission_data->>'application'),
    submission_data->>'name',
    submission_data->>'email',
    nullif(submission_data->>'phone', ''),
    nullif(submission_data->>'organization', ''),
    created_quote_id,
    jsonb_build_object(
      'timeline', nullif(submission_data->>'timeline', ''),
      'source_url', nullif(submission_data->>'source_url', '')
    )
  )
  returning id into created_thread_id;

  insert into public.support_messages (
    thread_id,
    project_id,
    direction,
    channel,
    from_email,
    from_name,
    to_emails,
    subject,
    body_text,
    metadata
  ) values (
    created_thread_id,
    (submission_data->>'project_id')::uuid,
    'inbound',
    'form',
    submission_data->>'email',
    submission_data->>'name',
    array['support@exacth2o.com']::text[],
    'Quote request: ' || (submission_data->>'application'),
    submission_data->>'message',
    jsonb_build_object(
      'quote_request_id', created_quote_id,
      'application', submission_data->>'application',
      'timeline', nullif(submission_data->>'timeline', '')
    )
  );

  return query select created_quote_id, false;
end;
$$;


ALTER FUNCTION "public"."save_public_quote_submission"("submission_data" "jsonb", "submission_fingerprint_value" "text", "notification_recipient" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_public_support_submission"("submission_data" "jsonb", "submission_fingerprint_value" "text") RETURNS TABLE("request_id" "uuid", "duplicate" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  created_thread_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only service_role may save public support submissions';
  end if;

  if jsonb_typeof(coalesce(submission_data, '{}'::jsonb)) <> 'object'
     or length(coalesce(submission_fingerprint_value, '')) < 32 then
    raise exception 'Invalid support submission input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('public-support:' || submission_fingerprint_value, 0));

  select thread.id
  into created_thread_id
  from public.support_threads thread
  where thread.submission_fingerprint = submission_fingerprint_value
    and thread.created_at > now() - interval '15 minutes'
  order by thread.created_at desc
  limit 1;

  if created_thread_id is not null then
    return query select created_thread_id, true;
    return;
  end if;

  insert into public.support_threads (
    project_id,
    source,
    status,
    priority,
    request_type,
    submission_fingerprint,
    subject,
    customer_name,
    customer_email,
    customer_phone,
    customer_organization,
    metadata
  ) values (
    (submission_data->>'project_id')::uuid,
    'form',
    'new',
    'normal',
    submission_data->>'request_type',
    submission_fingerprint_value,
    submission_data->>'subject',
    submission_data->>'name',
    submission_data->>'email',
    nullif(submission_data->>'phone', ''),
    nullif(submission_data->>'organization', ''),
    jsonb_build_object(
      'source_url', nullif(submission_data->>'source_url', ''),
      'referrer', nullif(submission_data->>'referrer', ''),
      'origin', nullif(submission_data->>'origin', ''),
      'user_agent', nullif(submission_data->>'user_agent', '')
    )
  )
  returning id into created_thread_id;

  insert into public.support_messages (
    thread_id,
    project_id,
    direction,
    channel,
    from_email,
    from_name,
    to_emails,
    subject,
    body_text,
    metadata
  ) values (
    created_thread_id,
    (submission_data->>'project_id')::uuid,
    'inbound',
    'form',
    submission_data->>'email',
    submission_data->>'name',
    array['support@exacth2o.com']::text[],
    submission_data->>'subject',
    submission_data->>'message',
    jsonb_build_object(
      'request_type', submission_data->>'request_type',
      'source_url', nullif(submission_data->>'source_url', '')
    )
  );

  return query select created_thread_id, false;
end;
$$;


ALTER FUNCTION "public"."save_public_support_submission"("submission_data" "jsonb", "submission_fingerprint_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."support_message_preview"("body_text" "text", "body_html" "text", "subject" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select nullif(
    left(
      regexp_replace(
        coalesce(
          nullif(trim(body_text), ''),
          nullif(trim(regexp_replace(coalesce(body_html, ''), '<[^>]+>', ' ', 'g')), ''),
          nullif(trim(subject), '')
        ),
        '\s+',
        ' ',
        'g'
      ),
      300
    ),
    ''
  );
$$;


ALTER FUNCTION "public"."support_message_preview"("body_text" "text", "body_html" "text", "subject" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_calibration_study_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_calibration_study_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_support_thread_from_message"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.support_threads
  set last_message_at = greatest(new.created_at, last_message_at),
      last_message_preview = coalesce(
        public.support_message_preview(new.body_text, new.body_html, new.subject),
        last_message_preview
      ),
      last_message_from_email = coalesce(new.from_email, last_message_from_email),
      last_message_subject = coalesce(new.subject, last_message_subject),
      updated_at = now()
  where id = new.thread_id;

  return new;
end;
$$;


ALTER FUNCTION "public"."touch_support_thread_from_message"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assistant_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "request_id" "uuid",
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "workflow" "text" DEFAULT 'answer'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "assistant_messages_content_check" CHECK ((("char_length"("content") >= 1) AND ("char_length"("content") <= 8000))),
    CONSTRAINT "assistant_messages_metadata_check" CHECK (("jsonb_typeof"("metadata") = 'object'::"text")),
    CONSTRAINT "assistant_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text"]))),
    CONSTRAINT "assistant_messages_workflow_check" CHECK (("workflow" = ANY (ARRAY['answer'::"text", 'experiment'::"text", 'settings'::"text", 'archive'::"text", 'schedule'::"text", 'monitor'::"text", 'lifecycle'::"text"])))
);


ALTER TABLE "public"."assistant_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assistant_monitor_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "monitor_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "state" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "observed_at" timestamp with time zone NOT NULL,
    "acknowledged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "assistant_monitor_events_evidence_check" CHECK (("jsonb_typeof"("evidence") = 'object'::"text")),
    CONSTRAINT "assistant_monitor_events_state_check" CHECK (("state" = ANY (ARRAY['triggered'::"text", 'resolved'::"text", 'unknown'::"text"]))),
    CONSTRAINT "assistant_monitor_events_summary_check" CHECK ((("char_length"("summary") >= 1) AND ("char_length"("summary") <= 300)))
);


ALTER TABLE "public"."assistant_monitor_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assistant_monitors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "experiment_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "metric" "text" NOT NULL,
    "comparator" "text" NOT NULL,
    "threshold" double precision,
    "window_minutes" integer NOT NULL,
    "pairing_names" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "check_every_minutes" integer NOT NULL,
    "cooldown_minutes" integer NOT NULL,
    "review_token_hash" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "last_state" "text" DEFAULT 'clear'::"text" NOT NULL,
    "last_evaluated_at" timestamp with time zone,
    "last_triggered_at" timestamp with time zone,
    "confirmed_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "assistant_monitors_check_every_minutes_check" CHECK ((("check_every_minutes" >= 5) AND ("check_every_minutes" <= 1440))),
    CONSTRAINT "assistant_monitors_comparator_check" CHECK (("comparator" = ANY (ARRAY['above'::"text", 'below'::"text", 'increase_by'::"text", 'decrease_by'::"text", 'stale'::"text", 'unhealthy'::"text"]))),
    CONSTRAINT "assistant_monitors_cooldown_minutes_check" CHECK ((("cooldown_minutes" >= 5) AND ("cooldown_minutes" <= 10080))),
    CONSTRAINT "assistant_monitors_last_state_check" CHECK (("last_state" = ANY (ARRAY['clear'::"text", 'triggered'::"text", 'unknown'::"text"]))),
    CONSTRAINT "assistant_monitors_metric_check" CHECK (("metric" = ANY (ARRAY['current_vwc'::"text", 'change_vwc'::"text", 'sensor_stale'::"text", 'controller_health'::"text"]))),
    CONSTRAINT "assistant_monitors_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 120))),
    CONSTRAINT "assistant_monitors_review_token_hash_check" CHECK (("char_length"("review_token_hash") = 64)),
    CONSTRAINT "assistant_monitors_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'canceled'::"text"]))),
    CONSTRAINT "assistant_monitors_threshold_check" CHECK ((("threshold" IS NULL) OR (("threshold" >= (0)::double precision) AND ("threshold" <= (100)::double precision)))),
    CONSTRAINT "assistant_monitors_window_minutes_check" CHECK ((("window_minutes" >= 5) AND ("window_minutes" <= 10080)))
);


ALTER TABLE "public"."assistant_monitors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assistant_schedule_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "schedule_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "batch_id" "uuid",
    "status" "text" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "assistant_schedule_runs_details_check" CHECK (("jsonb_typeof"("details") = 'object'::"text")),
    CONSTRAINT "assistant_schedule_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'queued'::"text", 'succeeded'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."assistant_schedule_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assistant_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" DEFAULT 'ExactH2O conversation'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "assistant_threads_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'archived'::"text"]))),
    CONSTRAINT "assistant_threads_title_check" CHECK ((("char_length"("title") >= 1) AND ("char_length"("title") <= 160)))
);


ALTER TABLE "public"."assistant_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calibration_candidates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "study_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "version" integer NOT NULL,
    "fit_type" "text" NOT NULL,
    "coefficients" "jsonb" NOT NULL,
    "equation_text" "text" NOT NULL,
    "sample_count" integer NOT NULL,
    "raw_min" double precision NOT NULL,
    "raw_max" double precision NOT NULL,
    "reference_min" double precision NOT NULL,
    "reference_max" double precision NOT NULL,
    "rmse" double precision NOT NULL,
    "mae" double precision NOT NULL,
    "r_squared" double precision NOT NULL,
    "max_error" double precision NOT NULL,
    "status" "text" NOT NULL,
    "created_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "calibration_candidates_coefficients_check" CHECK (("jsonb_typeof"("coefficients") = 'array'::"text")),
    CONSTRAINT "calibration_candidates_equation_text_check" CHECK ((("char_length"("equation_text") >= 1) AND ("char_length"("equation_text") <= 500))),
    CONSTRAINT "calibration_candidates_fit_type_check" CHECK (("fit_type" = ANY (ARRAY['linear'::"text", 'quadratic'::"text"]))),
    CONSTRAINT "calibration_candidates_mae_check" CHECK (("mae" >= (0)::double precision)),
    CONSTRAINT "calibration_candidates_max_error_check" CHECK (("max_error" >= (0)::double precision)),
    CONSTRAINT "calibration_candidates_rmse_check" CHECK (("rmse" >= (0)::double precision)),
    CONSTRAINT "calibration_candidates_sample_count_check" CHECK (("sample_count" >= 3)),
    CONSTRAINT "calibration_candidates_status_check" CHECK (("status" = ANY (ARRAY['preview'::"text", 'ready'::"text", 'archived'::"text"]))),
    CONSTRAINT "calibration_candidates_version_check" CHECK (("version" > 0))
);


ALTER TABLE "public"."calibration_candidates" OWNER TO "postgres";


COMMENT ON TABLE "public"."calibration_candidates" IS 'Immutable generated equation candidates. Candidate creation never applies a calibration.';



CREATE TABLE IF NOT EXISTS "public"."calibration_observations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "study_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "reference_recorded_at" timestamp with time zone NOT NULL,
    "reference_vwc" double precision NOT NULL,
    "sensor_reading_id" bigint,
    "matched_event_id" "text",
    "sensor_recorded_at" timestamp with time zone,
    "raw_value" double precision,
    "current_calibrated_value" double precision,
    "time_delta_seconds" integer,
    "match_status" "text" NOT NULL,
    "included" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "calibration_observations_check" CHECK (((("match_status" = 'matched'::"text") AND ("sensor_reading_id" IS NOT NULL) AND ("sensor_recorded_at" IS NOT NULL) AND ("raw_value" IS NOT NULL)) OR (("match_status" = 'unmatched'::"text") AND ("sensor_reading_id" IS NULL) AND ("sensor_recorded_at" IS NULL) AND ("raw_value" IS NULL)))),
    CONSTRAINT "calibration_observations_match_status_check" CHECK (("match_status" = ANY (ARRAY['matched'::"text", 'unmatched'::"text"]))),
    CONSTRAINT "calibration_observations_notes_check" CHECK ((("notes" IS NULL) OR ("char_length"("notes") <= 500))),
    CONSTRAINT "calibration_observations_reference_vwc_check" CHECK ((("reference_vwc" >= (0)::double precision) AND ("reference_vwc" <= (100)::double precision))),
    CONSTRAINT "calibration_observations_time_delta_seconds_check" CHECK ((("time_delta_seconds" IS NULL) OR ("time_delta_seconds" >= 0)))
);


ALTER TABLE "public"."calibration_observations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calibration_set_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_id" "uuid" NOT NULL,
    "study_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "pairing_names" "text"[] NOT NULL,
    "status" "text" DEFAULT 'approval_requested'::"text" NOT NULL,
    "requested_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "controller_command_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "notes" "text",
    CONSTRAINT "calibration_set_requests_notes_check" CHECK ((("notes" IS NULL) OR ("char_length"("notes") <= 1000))),
    CONSTRAINT "calibration_set_requests_pairing_names_check" CHECK ((("cardinality"("pairing_names") >= 1) AND ("cardinality"("pairing_names") <= 100))),
    CONSTRAINT "calibration_set_requests_status_check" CHECK (("status" = ANY (ARRAY['approval_requested'::"text", 'approved'::"text", 'applied'::"text", 'rejected'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."calibration_set_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."calibration_set_requests" IS 'Admin-only approval queue; V1 records intent but does not directly mutate the controller.';



CREATE TABLE IF NOT EXISTS "public"."calibration_studies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "experiment_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "sensor_key" "text" NOT NULL,
    "reference_instrument" "text",
    "reference_units" "text" DEFAULT 'VWC %'::"text" NOT NULL,
    "match_tolerance_seconds" integer DEFAULT 300 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "calibration_studies_experiment_id_check" CHECK (("experiment_id" = ANY (ARRAY['matt-experiment'::"text", 'matt-experiment-2'::"text", 'swc-saturation-calibration'::"text"]))),
    CONSTRAINT "calibration_studies_match_tolerance_seconds_check" CHECK ((("match_tolerance_seconds" >= 30) AND ("match_tolerance_seconds" <= 1800))),
    CONSTRAINT "calibration_studies_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 160))),
    CONSTRAINT "calibration_studies_pairing_name_check" CHECK ((("char_length"("pairing_name") >= 1) AND ("char_length"("pairing_name") <= 120))),
    CONSTRAINT "calibration_studies_reference_units_check" CHECK (("reference_units" = 'VWC %'::"text")),
    CONSTRAINT "calibration_studies_sensor_key_check" CHECK ((("char_length"("sensor_key") >= 1) AND ("char_length"("sensor_key") <= 120))),
    CONSTRAINT "calibration_studies_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'candidate'::"text", 'set_requested'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."calibration_studies" OWNER TO "postgres";


COMMENT ON TABLE "public"."calibration_studies" IS 'External-reference calibration workspaces; isolated from controller-applied calibration state.';



CREATE TABLE IF NOT EXISTS "public"."device_config_state" (
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "device_name" "text" DEFAULT 'plain-feather'::"text" NOT NULL,
    "source" "text" DEFAULT 'owner-health'::"text" NOT NULL,
    "observed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pairings" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "calibrations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "board_config" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "sensors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "valves" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "groups" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "pairing_count" integer DEFAULT 0 NOT NULL,
    "calibration_count" integer DEFAULT 0 NOT NULL,
    "board_count" integer DEFAULT 0 NOT NULL,
    "sensor_count" integer DEFAULT 0 NOT NULL,
    "valve_count" integer DEFAULT 0 NOT NULL,
    "group_count" integer DEFAULT 0 NOT NULL,
    "config_hash" "text",
    "endpoint_status" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "raw_config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."device_config_state" REPLICA IDENTITY FULL;


ALTER TABLE "public"."device_config_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_control_quarantines" (
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "command_id" "uuid",
    "reason" "text" NOT NULL,
    "quarantined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reconciled_at" timestamp with time zone,
    "reconciliation_details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."device_control_quarantines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_control_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "label" "text",
    "token_hash" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone,
    "disabled_at" timestamp with time zone,
    "disabled_reason" "text",
    CONSTRAINT "device_control_tokens_device_id_check" CHECK (("length"(TRIM(BOTH FROM "device_id")) > 0))
);


ALTER TABLE "public"."device_control_tokens" OWNER TO "postgres";


COMMENT ON TABLE "public"."device_control_tokens" IS 'Hashed device tokens used by controller-side command executors. Raw tokens are shown once and are never stored.';



CREATE TABLE IF NOT EXISTS "public"."device_health_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "device_name" "text" DEFAULT 'plain-feather'::"text" NOT NULL,
    "source" "text" DEFAULT 'owner-health'::"text" NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "owner_checked_at" timestamp with time zone,
    "status_endpoint_ok" boolean,
    "history_endpoint_ok" boolean,
    "status_http_status" integer,
    "status_elapsed_ms" integer,
    "history_samples" integer,
    "overall_status" "text",
    "api_status" "text",
    "pi_online" boolean,
    "public_url_reachable" boolean,
    "ethernet_link" boolean,
    "ethernet_ip" "text",
    "gateway_ping_ms" numeric,
    "undervoltage" boolean,
    "cpu_temp_c" numeric,
    "uptime_seconds" numeric,
    "sensors_expected" integer,
    "sensors_current" integer,
    "sensors_stale" integer,
    "sensors_missing" integer,
    "missing_sensors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "stale_sensors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "last_sensor_reading_at" timestamp with time zone,
    "watering_last_event" "text",
    "watering_last_event_at" timestamp with time zone,
    "watering_events_last_24h" integer,
    "scheduler_jobs_loaded" integer,
    "active_alerts" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "known_issues" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "raw_status" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "raw_history" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "raw_health" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "observation_key" "text",
    "ingest_complete" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."device_health_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_ingest_leases" (
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "holder" "uuid" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."device_ingest_leases" OWNER TO "postgres";


COMMENT ON TABLE "public"."device_ingest_leases" IS 'Short service-role leases that debounce concurrent health ingestion authorities.';



CREATE TABLE IF NOT EXISTS "public"."device_maintenance_state" (
    "task_name" "text" NOT NULL,
    "last_started_at" timestamp with time zone,
    "last_completed_at" timestamp with time zone,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."device_maintenance_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_runtime_state" (
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "device_name" "text" DEFAULT 'plain-feather'::"text" NOT NULL,
    "source" "text" DEFAULT 'owner-health'::"text" NOT NULL,
    "controller_state" "text" DEFAULT 'UNKNOWN'::"text" NOT NULL,
    "controller_state_raw" "text",
    "controller_state_updated_at" timestamp with time zone,
    "state_observed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "state_fresh_until" timestamp with time zone,
    "owner_checked_at" timestamp with time zone,
    "overall_status" "text",
    "api_status" "text",
    "pi_online" boolean,
    "public_url_reachable" boolean,
    "watering_enabled" boolean,
    "watering_disabled" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "watering_last_event" "text",
    "watering_last_event_at" timestamp with time zone,
    "watering_events_last_24h" integer,
    "scheduler_jobs_loaded" integer,
    "sensors_expected" integer,
    "sensors_current" integer,
    "sensors_stale" integer,
    "sensors_missing" integer,
    "last_sensor_reading_at" timestamp with time zone,
    "config_hash" "text",
    "raw_status" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "raw_health" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "raw_system" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."device_runtime_state" REPLICA IDENTITY FULL;


ALTER TABLE "public"."device_runtime_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_secrets" (
    "device_id" "text" NOT NULL,
    "token_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone
);


ALTER TABLE "public"."device_secrets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."devices" (
    "id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "balena_uuid" "text",
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "last_seen_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."devices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."experiment_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "revision_id" "uuid" NOT NULL,
    "experiment_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "zone" integer NOT NULL,
    "pot_number" integer NOT NULL,
    "crop" "text",
    "treatment" "text",
    "block" "text",
    "substrate" "text",
    "target_vwc_percent" double precision,
    "measurement_interval_minutes" double precision,
    "notes" "text",
    "sensor_key_snapshot" "text" NOT NULL,
    "valve_key_snapshot" "text" NOT NULL,
    "calibration_name_snapshot" "text",
    "source_target_vwc_percent" double precision,
    "source_valve_open_time_ms" integer,
    "source_measurement_interval_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "experiment_assignments_block_check" CHECK ((("block" IS NULL) OR ("char_length"("block") <= 80))),
    CONSTRAINT "experiment_assignments_crop_check" CHECK ((("crop" IS NULL) OR ("char_length"("crop") <= 80))),
    CONSTRAINT "experiment_assignments_measurement_interval_minutes_check" CHECK ((("measurement_interval_minutes" IS NULL) OR (("measurement_interval_minutes" >= (0.5)::double precision) AND ("measurement_interval_minutes" <= (1440)::double precision)))),
    CONSTRAINT "experiment_assignments_notes_check" CHECK ((("notes" IS NULL) OR ("char_length"("notes") <= 300))),
    CONSTRAINT "experiment_assignments_pairing_name_check" CHECK ((("char_length"("pairing_name") >= 1) AND ("char_length"("pairing_name") <= 120))),
    CONSTRAINT "experiment_assignments_pot_number_check" CHECK ((("pot_number" >= 1) AND ("pot_number" <= 10000))),
    CONSTRAINT "experiment_assignments_sensor_key_snapshot_check" CHECK ((("char_length"("sensor_key_snapshot") >= 1) AND ("char_length"("sensor_key_snapshot") <= 160))),
    CONSTRAINT "experiment_assignments_substrate_check" CHECK ((("substrate" IS NULL) OR ("char_length"("substrate") <= 80))),
    CONSTRAINT "experiment_assignments_target_vwc_percent_check" CHECK ((("target_vwc_percent" IS NULL) OR (("target_vwc_percent" >= (0)::double precision) AND ("target_vwc_percent" <= (100)::double precision)))),
    CONSTRAINT "experiment_assignments_treatment_check" CHECK ((("treatment" IS NULL) OR ("char_length"("treatment") <= 80))),
    CONSTRAINT "experiment_assignments_valve_key_snapshot_check" CHECK ((("char_length"("valve_key_snapshot") >= 1) AND ("char_length"("valve_key_snapshot") <= 160))),
    CONSTRAINT "experiment_assignments_zone_check" CHECK ((("zone" >= 1) AND ("zone" <= 100)))
);


ALTER TABLE "public"."experiment_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."experiment_audit_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "experiment_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "revision_id" "uuid",
    "event_type" "text" NOT NULL,
    "actor_id" "uuid",
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "experiment_audit_events_details_check" CHECK (("jsonb_typeof"("details") = 'object'::"text")),
    CONSTRAINT "experiment_audit_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['legacy_imported'::"text", 'published_sensing'::"text", 'activation_requested'::"text", 'activation_succeeded'::"text", 'activation_failed'::"text", 'completed'::"text", 'archived'::"text", 'restored'::"text"])))
);


ALTER TABLE "public"."experiment_audit_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."experiment_builder_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "source" "text" NOT NULL,
    "status" "text" NOT NULL,
    "model_name" "text",
    "prompt_fingerprint" "text",
    "input_tokens" integer,
    "output_tokens" integer,
    "error_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "experiment_builder_requests_input_tokens_check" CHECK ((("input_tokens" IS NULL) OR ("input_tokens" >= 0))),
    CONSTRAINT "experiment_builder_requests_output_tokens_check" CHECK ((("output_tokens" IS NULL) OR ("output_tokens" >= 0))),
    CONSTRAINT "experiment_builder_requests_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'natural_language'::"text"]))),
    CONSTRAINT "experiment_builder_requests_status_check" CHECK (("status" = ANY (ARRAY['started'::"text", 'completed'::"text", 'rejected'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."experiment_builder_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."experiment_control_plan_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "sequence" integer NOT NULL,
    "label" "text" NOT NULL,
    "command_type" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "confirm" boolean DEFAULT false NOT NULL,
    "client_request_id" "uuid" NOT NULL,
    "command_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "experiment_control_plan_steps_command_type_check" CHECK (("command_type" = ANY (ARRAY['update_system_state'::"text", 'bulk_update_pairings'::"text"]))),
    CONSTRAINT "experiment_control_plan_steps_label_check" CHECK ((("char_length"("label") >= 1) AND ("char_length"("label") <= 160))),
    CONSTRAINT "experiment_control_plan_steps_payload_check" CHECK (("jsonb_typeof"("payload") = 'object'::"text")),
    CONSTRAINT "experiment_control_plan_steps_sequence_check" CHECK ((("sequence" >= 1) AND ("sequence" <= 60)))
);


ALTER TABLE "public"."experiment_control_plan_steps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."experiment_control_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "experiment_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "batch_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "status" "text" DEFAULT 'prepared'::"text" NOT NULL,
    "expected_step_count" integer NOT NULL,
    "expected_inventory_updated_at" timestamp with time zone NOT NULL,
    "expected_config_hash" "text" NOT NULL,
    "final_watering_state" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "confirmed_at" timestamp with time zone NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "experiment_control_plans_expected_step_count_check" CHECK ((("expected_step_count" >= 0) AND ("expected_step_count" <= 60))),
    CONSTRAINT "experiment_control_plans_final_watering_state_check" CHECK (("final_watering_state" = ANY (ARRAY['off'::"text", 'controller_managed'::"text"]))),
    CONSTRAINT "experiment_control_plans_status_check" CHECK (("status" = ANY (ARRAY['prepared'::"text", 'queued'::"text", 'executing'::"text", 'active'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."experiment_control_plans" OWNER TO "postgres";


COMMENT ON TABLE "public"."experiment_control_plans" IS 'Reviewed controller activation plans compiled from immutable experiment specifications.';



CREATE TABLE IF NOT EXISTS "public"."experiment_revisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "experiment_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "version" integer NOT NULL,
    "source" "text" NOT NULL,
    "spec" "jsonb" NOT NULL,
    "inventory_updated_at" timestamp with time zone,
    "inventory_hash" "text",
    "model_name" "text",
    "prompt_fingerprint" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "experiment_revisions_source_check" CHECK (("source" = ANY (ARRAY['legacy'::"text", 'manual'::"text", 'natural_language'::"text"]))),
    CONSTRAINT "experiment_revisions_spec_check" CHECK (("jsonb_typeof"("spec") = 'object'::"text")),
    CONSTRAINT "experiment_revisions_version_check" CHECK (("version" > 0))
);


ALTER TABLE "public"."experiment_revisions" OWNER TO "postgres";


COMMENT ON TABLE "public"."experiment_revisions" IS 'Immutable experiment specifications and inventory provenance.';



CREATE TABLE IF NOT EXISTS "public"."experiments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "mode" "text" NOT NULL,
    "status" "text" DEFAULT 'published_sensing'::"text" NOT NULL,
    "watering_state" "text" DEFAULT 'off'::"text" NOT NULL,
    "visible_to_roles" "text"[] DEFAULT ARRAY['admin'::"text", 'researcher'::"text"] NOT NULL,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "current_revision_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "experiments_description_check" CHECK (("char_length"("description") <= 300)),
    CONSTRAINT "experiments_mode_check" CHECK (("mode" = ANY (ARRAY['controlled'::"text", 'observation'::"text", 'calibration'::"text"]))),
    CONSTRAINT "experiments_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 120))),
    CONSTRAINT "experiments_slug_check" CHECK ((("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::"text") AND ("char_length"("slug") <= 80))),
    CONSTRAINT "experiments_status_check" CHECK (("status" = ANY (ARRAY['published_sensing'::"text", 'activating'::"text", 'active'::"text", 'activation_failed'::"text", 'completed'::"text", 'archived'::"text"]))),
    CONSTRAINT "experiments_visible_to_roles_check" CHECK ((("visible_to_roles" <@ ARRAY['admin'::"text", 'researcher'::"text"]) AND ("visible_to_roles" @> ARRAY['admin'::"text"]))),
    CONSTRAINT "experiments_watering_state_check" CHECK (("watering_state" = ANY (ARRAY['off'::"text", 'controller_managed'::"text"])))
);


ALTER TABLE "public"."experiments" OWNER TO "postgres";


COMMENT ON TABLE "public"."experiments" IS 'Portal experiment catalog. Builder-created experiments are sensing-only and never issue controller commands.';



CREATE TABLE IF NOT EXISTS "public"."latest_device_state" (
    "device_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "last_seen_at" timestamp with time zone NOT NULL,
    "health_status" "text" NOT NULL,
    "latest_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."latest_device_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pairings" (
    "id" bigint NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "zone" integer,
    "pot_number" integer,
    "source_sensor_id" integer NOT NULL,
    "sensor_key" "text" NOT NULL,
    "source_valve_id" integer NOT NULL,
    "valve_key" "text" NOT NULL,
    "wtc_percent_limit" numeric,
    "valve_open_time_ms" integer,
    "measurement_interval_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pairings" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."pairings_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."pairings_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."pairings_id_seq" OWNED BY "public"."pairings"."id";



CREATE TABLE IF NOT EXISTS "public"."portal_access" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "portal_access_email_check" CHECK (("email" = "lower"(TRIM(BOTH FROM "email")))),
    CONSTRAINT "portal_access_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'researcher'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."portal_access" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."portal_experiment_catalog" WITH ("security_invoker"='true') AS
 SELECT "e"."id",
    "e"."project_id",
    "e"."slug",
    "e"."name",
    "e"."description",
    "e"."mode",
    "e"."status",
    "e"."watering_state",
    "e"."visible_to_roles",
    "e"."started_at",
    "e"."ended_at",
    "e"."created_at",
    "e"."updated_at",
    "e"."current_revision_id",
    "r"."version" AS "current_version",
    COALESCE(( SELECT "array_agg"("a"."pairing_name" ORDER BY "a"."zone", "a"."pot_number") AS "array_agg"
           FROM "public"."experiment_assignments" "a"
          WHERE ("a"."revision_id" = "e"."current_revision_id")), '{}'::"text"[]) AS "pairing_names",
    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('pairing_name', "a"."pairing_name", 'zone', "a"."zone", 'pot_number', "a"."pot_number", 'crop', "a"."crop", 'treatment', "a"."treatment", 'block', "a"."block", 'substrate', "a"."substrate", 'target_vwc_percent', "a"."target_vwc_percent", 'measurement_interval_minutes', "a"."measurement_interval_minutes", 'sensor_key_snapshot', "a"."sensor_key_snapshot", 'valve_key_snapshot', "a"."valve_key_snapshot", 'calibration_name_snapshot', "a"."calibration_name_snapshot") ORDER BY "a"."zone", "a"."pot_number") AS "jsonb_agg"
           FROM "public"."experiment_assignments" "a"
          WHERE ("a"."revision_id" = "e"."current_revision_id")), '[]'::"jsonb") AS "assignments"
   FROM ("public"."experiments" "e"
     LEFT JOIN "public"."experiment_revisions" "r" ON (("r"."id" = "e"."current_revision_id")))
  WHERE ("e"."status" <> 'archived'::"text");


ALTER VIEW "public"."portal_experiment_catalog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_control_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "command_id" "uuid",
    "project_id" "uuid" NOT NULL,
    "device_id" "text",
    "action" "text" NOT NULL,
    "actor_id" "uuid",
    "status" "text" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_control_audit" OWNER TO "postgres";


COMMENT ON TABLE "public"."project_control_audit" IS 'Audit trail for portal control actions, including queued, accepted, applied, failed, and canceled events.';



CREATE TABLE IF NOT EXISTS "public"."project_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "token_hash" "text" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'owner'::"text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '14 days'::interval) NOT NULL,
    "accepted_at" timestamp with time zone,
    "accepted_by" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "project_invites_acceptance_pair" CHECK (((("accepted_at" IS NULL) AND ("accepted_by" IS NULL)) OR (("accepted_at" IS NOT NULL) AND ("accepted_by" IS NOT NULL)))),
    CONSTRAINT "project_invites_email_check" CHECK ((("char_length"(TRIM(BOTH FROM "email")) >= 3) AND ("char_length"(TRIM(BOTH FROM "email")) <= 200))),
    CONSTRAINT "project_invites_email_lowercase" CHECK (("email" = "lower"(TRIM(BOTH FROM "email")))),
    CONSTRAINT "project_invites_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'member'::"text", 'viewer'::"text"]))),
    CONSTRAINT "project_invites_token_hash_check" CHECK (("char_length"("token_hash") = 64))
);


ALTER TABLE "public"."project_invites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_members" (
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "project_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'researcher'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."project_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."public_submission_rate_limits" (
    "scope" "text" NOT NULL,
    "client_hash" "text" NOT NULL,
    "window_started_at" timestamp with time zone NOT NULL,
    "request_count" integer DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."public_submission_rate_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."quote_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone" "text",
    "organization" "text",
    "application" "text" NOT NULL,
    "timeline" "text",
    "message" "text" NOT NULL,
    "source_url" "text",
    "referrer" "text",
    "origin" "text",
    "user_agent" "text",
    "notification_email" "text" DEFAULT 'bslbinod@gmail.com'::"text" NOT NULL,
    "notification_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notification_error" "text",
    "resend_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "project_id" "uuid" DEFAULT '22222222-2222-4222-8222-222222222222'::"uuid" NOT NULL,
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "submission_fingerprint" "text",
    CONSTRAINT "quote_requests_application_check" CHECK ((("char_length"(TRIM(BOTH FROM "application")) >= 1) AND ("char_length"(TRIM(BOTH FROM "application")) <= 120))),
    CONSTRAINT "quote_requests_email_check" CHECK ((("char_length"(TRIM(BOTH FROM "email")) >= 3) AND ("char_length"(TRIM(BOTH FROM "email")) <= 200))),
    CONSTRAINT "quote_requests_message_check" CHECK ((("char_length"(TRIM(BOTH FROM "message")) >= 1) AND ("char_length"(TRIM(BOTH FROM "message")) <= 3000))),
    CONSTRAINT "quote_requests_name_check" CHECK ((("char_length"(TRIM(BOTH FROM "name")) >= 1) AND ("char_length"(TRIM(BOTH FROM "name")) <= 120))),
    CONSTRAINT "quote_requests_notification_status_check" CHECK (("notification_status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text"]))),
    CONSTRAINT "quote_requests_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'urgent'::"text"]))),
    CONSTRAINT "quote_requests_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'open'::"text", 'quoted'::"text", 'waiting_on_customer'::"text", 'won'::"text", 'lost'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."quote_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_access_audit" (
    "id" bigint NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "prediction_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."rd_access_audit" OWNER TO "postgres";


ALTER TABLE "public"."rd_access_audit" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."rd_access_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."rd_correction_episodes_v2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "episode_key" "text" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "first_open_event_id" "text" NOT NULL,
    "first_open_device_at" timestamp with time zone NOT NULL,
    "last_open_device_at" timestamp with time zone NOT NULL,
    "target_vwc_at_start" double precision NOT NULL,
    "config_hash_at_start" "text" NOT NULL,
    "pulse_count" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "correction_ended_at" timestamp with time zone,
    "observation_ends_at" timestamp with time zone NOT NULL,
    "completed_at" timestamp with time zone,
    "quality" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_correction_episodes_v2_pulse_count_check" CHECK (("pulse_count" >= 0)),
    CONSTRAINT "rd_correction_episodes_v2_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'observing'::"text", 'complete'::"text"])))
);


ALTER TABLE "public"."rd_correction_episodes_v2" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_correction_episodes_v2" IS 'Groups repeated automatic opens for one pot while retaining every atomic event.';



CREATE TABLE IF NOT EXISTS "public"."rd_curve_outcomes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "episode_id" "uuid" NOT NULL,
    "baseline_vwc" double precision NOT NULL,
    "baseline_reading_id" bigint,
    "actual_absolute" "jsonb" NOT NULL,
    "actual_delta" "jsonb" NOT NULL,
    "observed_horizons" integer NOT NULL,
    "censored" boolean DEFAULT false NOT NULL,
    "censor_reason" "text",
    "eligible_for_training" boolean DEFAULT false NOT NULL,
    "quality_reasons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "completed_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_curve_outcomes_observed_horizons_check" CHECK (("observed_horizons" >= 0))
);


ALTER TABLE "public"."rd_curve_outcomes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_curve_predictions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "prediction_key" "text" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "episode_id" "uuid",
    "model_version_id" "uuid" NOT NULL,
    "band" "text" NOT NULL,
    "trigger_reading_id" bigint,
    "trigger_vwc" double precision NOT NULL,
    "target_vwc_at_issue" double precision NOT NULL,
    "configured_valve_open_ms" integer NOT NULL,
    "measurement_interval_ms" integer NOT NULL,
    "calibration_version" "text" NOT NULL,
    "config_hash" "text" NOT NULL,
    "feature_as_of_device_at" timestamp with time zone NOT NULL,
    "issued_at" timestamp with time zone NOT NULL,
    "feature_hash" "text" NOT NULL,
    "features" "jsonb" NOT NULL,
    "p10" "jsonb" NOT NULL,
    "p50" "jsonb" NOT NULL,
    "p90" "jsonb" NOT NULL,
    "confidence" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_curve_predictions_band_check" CHECK (("band" = ANY (ARRAY['early'::"text", 'refresh'::"text", 'revision'::"text"]))),
    CONSTRAINT "rd_curve_predictions_confidence_check" CHECK (("confidence" = ANY (ARRAY['trained_range'::"text", 'low_confidence'::"text", 'out_of_distribution'::"text"])))
);


ALTER TABLE "public"."rd_curve_predictions" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_curve_predictions" IS 'Immutable shadow forecasts. Browser access is only through the system-admin DTO function.';



CREATE TABLE IF NOT EXISTS "public"."rd_episode_outcomes_v2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "episode_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "baseline_vwc" double precision NOT NULL,
    "baseline_reading_id" bigint,
    "baseline_device_at" timestamp with time zone NOT NULL,
    "first_open_device_at" timestamp with time zone NOT NULL,
    "last_open_device_at" timestamp with time zone NOT NULL,
    "actual_absolute" "jsonb" NOT NULL,
    "actual_delta" "jsonb" NOT NULL,
    "observed_horizons" integer NOT NULL,
    "pulse_count" integer NOT NULL,
    "eligible_for_scoring" boolean DEFAULT false NOT NULL,
    "eligible_for_training" boolean DEFAULT false NOT NULL,
    "quality_reasons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "outcome_version" "text" DEFAULT 'episode-total-last-open-v1'::"text" NOT NULL,
    "completed_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_episode_outcomes_v2_observed_horizons_check" CHECK (("observed_horizons" >= 0)),
    CONSTRAINT "rd_episode_outcomes_v2_pulse_count_check" CHECK (("pulse_count" > 0))
);


ALTER TABLE "public"."rd_episode_outcomes_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_episode_outcomes_v3" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "episode_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "baseline_vwc" double precision NOT NULL,
    "baseline_reading_id" bigint,
    "baseline_device_at" timestamp with time zone NOT NULL,
    "first_open_device_at" timestamp with time zone NOT NULL,
    "last_open_device_at" timestamp with time zone NOT NULL,
    "config_hash_at_start" "text" NOT NULL,
    "observation_end_device_at" timestamp with time zone NOT NULL,
    "actual_absolute" "jsonb" NOT NULL,
    "actual_delta" "jsonb" NOT NULL,
    "observed_horizons" integer NOT NULL,
    "pulse_count" integer NOT NULL,
    "sample_interval_minutes" integer DEFAULT 10 NOT NULL,
    "right_censored" boolean DEFAULT false NOT NULL,
    "eligible_for_scoring" boolean DEFAULT false NOT NULL,
    "eligible_for_training" boolean DEFAULT false NOT NULL,
    "quality_reasons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "outcome_version" "text" DEFAULT 'episode-total-first-open-v2'::"text" NOT NULL,
    "completed_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_episode_outcomes_v3_observed_horizons_check" CHECK (("observed_horizons" >= 0)),
    CONSTRAINT "rd_episode_outcomes_v3_pulse_count_check" CHECK (("pulse_count" > 0)),
    CONSTRAINT "rd_episode_outcomes_v3_sample_interval_minutes_check" CHECK (("sample_interval_minutes" > 0))
);


ALTER TABLE "public"."rd_episode_outcomes_v3" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_episode_outcomes_v3" IS 'First-open-clock, sensor-cadence episode totals for the shadow-only R&D pipeline.';



CREATE TABLE IF NOT EXISTS "public"."rd_episode_scores_v2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "episode_id" "uuid" NOT NULL,
    "outcome_id" "uuid" NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "model_role" "text" NOT NULL,
    "curve_mae" double precision,
    "peak_error" double precision,
    "time_to_peak_error_minutes" double precision,
    "integrated_response_error" double precision,
    "interval_coverage" double precision,
    "scored_horizons" integer NOT NULL,
    "scoring_version" "text" DEFAULT 'episode-total-score-v1'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_episode_scores_v2_model_role_check" CHECK (("model_role" = ANY (ARRAY['baseline'::"text", 'candidate'::"text", 'champion'::"text"]))),
    CONSTRAINT "rd_episode_scores_v2_scored_horizons_check" CHECK (("scored_horizons" >= 0))
);


ALTER TABLE "public"."rd_episode_scores_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_episode_scores_v3" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "episode_id" "uuid" NOT NULL,
    "outcome_id" "uuid" NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "model_role" "text" NOT NULL,
    "curve_mae" double precision,
    "peak_error" double precision,
    "time_to_peak_error_minutes" double precision,
    "integrated_response_error" double precision,
    "interval_coverage" double precision,
    "scored_horizons" integer NOT NULL,
    "scoring_version" "text" DEFAULT 'episode-first-open-score-v2'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_episode_scores_v3_model_role_check" CHECK (("model_role" = ANY (ARRAY['baseline'::"text", 'candidate'::"text", 'champion'::"text"]))),
    CONSTRAINT "rd_episode_scores_v3_scored_horizons_check" CHECK (("scored_horizons" >= 0))
);


ALTER TABLE "public"."rd_episode_scores_v3" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_evaluation_windows_v2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "window_number" integer NOT NULL,
    "train_ended_at" timestamp with time zone NOT NULL,
    "evaluation_started_at" timestamp with time zone NOT NULL,
    "evaluation_ended_at" timestamp with time zone NOT NULL,
    "episode_count" integer NOT NULL,
    "multi_pulse_episode_count" integer NOT NULL,
    "pot_count" integer NOT NULL,
    "baseline_curve_mae" double precision,
    "candidate_curve_mae" double precision,
    "improvement_percent" double precision,
    "interval_coverage" double precision,
    "passed" boolean DEFAULT false NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_evaluation_windows_v2_episode_count_check" CHECK (("episode_count" > 0)),
    CONSTRAINT "rd_evaluation_windows_v2_multi_pulse_episode_count_check" CHECK (("multi_pulse_episode_count" >= 0)),
    CONSTRAINT "rd_evaluation_windows_v2_pot_count_check" CHECK (("pot_count" > 0)),
    CONSTRAINT "rd_evaluation_windows_v2_window_number_check" CHECK (("window_number" = ANY (ARRAY[1, 2])))
);


ALTER TABLE "public"."rd_evaluation_windows_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_event_attributions_v2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "irrigation_event_id" "uuid" NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "p10" "jsonb" NOT NULL,
    "p50" "jsonb" NOT NULL,
    "p90" "jsonb" NOT NULL,
    "label_type" "text" DEFAULT 'model_attribution'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_event_attributions_v2_label_type_check" CHECK (("label_type" = 'model_attribution'::"text"))
);


ALTER TABLE "public"."rd_event_attributions_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_event_exclusions_v4" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "irrigation_event_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_event_exclusions_v4_reason_check" CHECK (("reason" = ANY (ARRAY['no_verified_pre_open_reading'::"text", 'stale_pre_open_reading'::"text"])))
);


ALTER TABLE "public"."rd_event_exclusions_v4" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_event_finalizations_v5" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "irrigation_event_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "opened_device_at" timestamp with time zone NOT NULL,
    "feature_hash" "text" NOT NULL,
    "evidence_fingerprint" "text" NOT NULL,
    "finalization_revision" integer NOT NULL,
    "supersedes_finalization_id" "uuid",
    "finalization_reason" "text" NOT NULL,
    "terminal_device_at" timestamp with time zone NOT NULL,
    "horizon_manifest" "jsonb" NOT NULL,
    "observed_horizons" integer NOT NULL,
    "censored_horizons" integer NOT NULL,
    "duration_source" "text" NOT NULL,
    "quality" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_event_finalizations_v5_censored_horizons_check" CHECK (("censored_horizons" >= 0)),
    CONSTRAINT "rd_event_finalizations_v5_duration_source_check" CHECK (("duration_source" = ANY (ARRAY['observed_event'::"text", 'configured_snapshot'::"text", 'unknown'::"text"]))),
    CONSTRAINT "rd_event_finalizations_v5_finalization_reason_check" CHECK (("finalization_reason" = ANY (ARRAY['next_pulse'::"text", 'full_horizon'::"text"]))),
    CONSTRAINT "rd_event_finalizations_v5_finalization_revision_check" CHECK (("finalization_revision" > 0)),
    CONSTRAINT "rd_event_finalizations_v5_horizon_manifest_check" CHECK (("jsonb_typeof"("horizon_manifest") = 'array'::"text")),
    CONSTRAINT "rd_event_finalizations_v5_observed_horizons_check" CHECK (("observed_horizons" >= 3))
);


ALTER TABLE "public"."rd_event_finalizations_v5" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_event_finalizations_v5" IS 'Private immutable finalized event manifests for V5 training; no control path.';



CREATE TABLE IF NOT EXISTS "public"."rd_feature_snapshots_v4" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "irrigation_event_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "opened_device_at" timestamp with time zone NOT NULL,
    "feature_as_of_device_at" timestamp with time zone NOT NULL,
    "latest_reading_id" bigint,
    "latest_reading_device_at" timestamp with time zone,
    "feature_hash" "text" NOT NULL,
    "features" "jsonb" NOT NULL,
    "source" "text" NOT NULL,
    "quality" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_feature_snapshots_v4_check" CHECK (("feature_as_of_device_at" = "opened_device_at")),
    CONSTRAINT "rd_feature_snapshots_v4_check1" CHECK ((("latest_reading_device_at" IS NULL) OR ("latest_reading_device_at" < "opened_device_at"))),
    CONSTRAINT "rd_feature_snapshots_v4_source_check" CHECK (("source" = 'causal_pre_open_reconstruction_v4'::"text"))
);


ALTER TABLE "public"."rd_feature_snapshots_v4" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_irrigation_episodes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "first_open_event_id" "text" NOT NULL,
    "first_open_device_at" timestamp with time zone NOT NULL,
    "episode_kind" "text" NOT NULL,
    "target_vwc_at_open" double precision NOT NULL,
    "config_hash_at_open" "text" NOT NULL,
    "pulse_count" integer DEFAULT 1 NOT NULL,
    "censor_at" timestamp with time zone,
    "censor_reason" "text",
    "quality" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_irrigation_episodes_episode_kind_check" CHECK (("episode_kind" = ANY (ARRAY['automatic_first_pulse'::"text", 'manual_pulse'::"text", 'conflict_retry'::"text", 'unknown_source'::"text"]))),
    CONSTRAINT "rd_irrigation_episodes_pulse_count_check" CHECK (("pulse_count" > 0))
);


ALTER TABLE "public"."rd_irrigation_episodes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_irrigation_events_v2" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "valve_event_id" "text" NOT NULL,
    "episode_id" "uuid" NOT NULL,
    "sequence_in_episode" integer NOT NULL,
    "prediction_id" "uuid",
    "prediction_status" "text" NOT NULL,
    "opened_device_at" timestamp with time zone NOT NULL,
    "closed_device_at" timestamp with time zone,
    "duration_ms" integer,
    "duration_source" "text" NOT NULL,
    "source_class" "text" NOT NULL,
    "evidence_source" "text" NOT NULL,
    "prediction_lead_seconds" integer,
    "quality" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_irrigation_events_v2_duration_ms_check" CHECK ((("duration_ms" IS NULL) OR ("duration_ms" >= 0))),
    CONSTRAINT "rd_irrigation_events_v2_duration_source_check" CHECK (("duration_source" = ANY (ARRAY['observed_event'::"text", 'configured_snapshot'::"text", 'unknown'::"text"]))),
    CONSTRAINT "rd_irrigation_events_v2_prediction_status_check" CHECK (("prediction_status" = ANY (ARRAY['committed'::"text", 'missed_causal_window'::"text"]))),
    CONSTRAINT "rd_irrigation_events_v2_sequence_in_episode_check" CHECK (("sequence_in_episode" > 0))
);


ALTER TABLE "public"."rd_irrigation_events_v2" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_irrigation_events_v2" IS 'One immutable shadow record per confirmed automatic valve open. No controller writes.';



CREATE TABLE IF NOT EXISTS "public"."rd_model_promotions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "previous_model_version_id" "uuid",
    "decision" "text" NOT NULL,
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "actor_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_model_promotions_decision_check" CHECK (("decision" = ANY (ARRAY['promoted'::"text", 'rolled_back'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."rd_model_promotions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_model_updates_v4" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "previous_model_version_id" "uuid",
    "evidence_fingerprint" "text" NOT NULL,
    "training_event_count" integer NOT NULL,
    "training_horizon_count" integer NOT NULL,
    "artifact_path" "text" NOT NULL,
    "artifact_sha256" "text" NOT NULL,
    "code_commit" "text" NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_model_updates_v4_artifact_path_check" CHECK (("artifact_path" ~~ 'gs://%'::"text")),
    CONSTRAINT "rd_model_updates_v4_training_event_count_check" CHECK (("training_event_count" > 0)),
    CONSTRAINT "rd_model_updates_v4_training_horizon_count_check" CHECK (("training_horizon_count" > 0))
);


ALTER TABLE "public"."rd_model_updates_v4" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_model_updates_v5" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "previous_model_version_id" "uuid",
    "evidence_fingerprint" "text" NOT NULL,
    "training_event_count" integer NOT NULL,
    "training_horizon_count" integer NOT NULL,
    "dataset_manifest" "jsonb" NOT NULL,
    "artifact_path" "text" NOT NULL,
    "artifact_sha256" "text" NOT NULL,
    "code_commit" "text" NOT NULL,
    "parameters" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_model_updates_v5_artifact_path_check" CHECK (("artifact_path" ~~ 'gs://%'::"text")),
    CONSTRAINT "rd_model_updates_v5_code_commit_check" CHECK ((("length"("code_commit") >= 7) AND ("code_commit" <> 'unknown'::"text"))),
    CONSTRAINT "rd_model_updates_v5_dataset_manifest_check" CHECK (("jsonb_typeof"("dataset_manifest") = 'array'::"text")),
    CONSTRAINT "rd_model_updates_v5_training_event_count_check" CHECK (("training_event_count" >= 40)),
    CONSTRAINT "rd_model_updates_v5_training_horizon_count_check" CHECK (("training_horizon_count" >= 120))
);


ALTER TABLE "public"."rd_model_updates_v5" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_model_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "version" "text" NOT NULL,
    "status" "text" NOT NULL,
    "artifact_path" "text",
    "artifact_sha256" "text",
    "feature_schema_version" "text" NOT NULL,
    "training_dataset_hash" "text",
    "training_event_count" integer DEFAULT 0 NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "synthetic_data_only" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_model_versions_status_check" CHECK (("status" = ANY (ARRAY['baseline'::"text", 'candidate'::"text", 'champion'::"text", 'retired'::"text"])))
);


ALTER TABLE "public"."rd_model_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_observer_state" (
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "last_reading_id" bigint,
    "previous_vwc" double precision,
    "active_band" "text",
    "active_prediction_id" "uuid",
    "active_episode_id" "uuid",
    "config_hash" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."rd_observer_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_pairing_adapters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "adapter_version" "text" NOT NULL,
    "status" "text" NOT NULL,
    "artifact_path" "text" NOT NULL,
    "artifact_sha256" "text" NOT NULL,
    "events_incorporated" integer DEFAULT 0 NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_pairing_adapters_status_check" CHECK (("status" = ANY (ARRAY['shadow'::"text", 'validated'::"text", 'retired'::"text"])))
);


ALTER TABLE "public"."rd_pairing_adapters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_post_open_scores_v5" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_model_version_id" "uuid" NOT NULL,
    "champion_model_version_id" "uuid" NOT NULL,
    "source_prediction_id" "uuid" NOT NULL,
    "irrigation_event_id" "uuid" NOT NULL,
    "event_finalization_id" "uuid" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "opened_device_at" timestamp with time zone NOT NULL,
    "pulse_sequence_in_episode" integer NOT NULL,
    "outcome_evidence_fingerprint" "text" NOT NULL,
    "observation_fingerprint" "text" NOT NULL,
    "observation_max_server_received_at" timestamp with time zone,
    "maturity" "text" NOT NULL,
    "evaluation_mode" "text" NOT NULL,
    "candidate_curve_mae" double precision,
    "champion_curve_mae" double precision,
    "zero_curve_mae" double precision,
    "candidate_signed_bias" double precision,
    "champion_signed_bias" double precision,
    "zero_signed_bias" double precision,
    "interval_coverage" double precision,
    "scored_horizons" integer NOT NULL,
    "continuous_candidate_curve_mae" double precision,
    "continuous_champion_curve_mae" double precision,
    "continuous_zero_curve_mae" double precision,
    "continuous_candidate_signed_bias" double precision,
    "continuous_champion_signed_bias" double precision,
    "continuous_zero_signed_bias" double precision,
    "continuous_interval_coverage" double precision,
    "continuous_scored_readings" integer DEFAULT 0 NOT NULL,
    "ood_score" double precision DEFAULT 0 NOT NULL,
    "scoring_version" "text" DEFAULT 'post-open-continuous-v1'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_post_open_scores_v5_continuous_scored_readings_check" CHECK (("continuous_scored_readings" >= 0)),
    CONSTRAINT "rd_post_open_scores_v5_evaluation_mode_check" CHECK (("evaluation_mode" = 'frozen_model_causal_feature_replay'::"text")),
    CONSTRAINT "rd_post_open_scores_v5_maturity_check" CHECK (("maturity" = 'final'::"text")),
    CONSTRAINT "rd_post_open_scores_v5_ood_score_check" CHECK (("ood_score" >= (0)::double precision)),
    CONSTRAINT "rd_post_open_scores_v5_pulse_sequence_in_episode_check" CHECK (("pulse_sequence_in_episode" > 0)),
    CONSTRAINT "rd_post_open_scores_v5_scored_horizons_check" CHECK (("scored_horizons" > 0)),
    CONSTRAINT "rd_post_open_scores_v5_scoring_version_check" CHECK (("scoring_version" = 'post-open-continuous-v1'::"text"))
);


ALTER TABLE "public"."rd_post_open_scores_v5" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_post_open_scores_v5" IS 'Private final-maturity shadow scores excluding the pre-open baseline anchor; no actuation path.';



CREATE TABLE IF NOT EXISTS "public"."rd_prediction_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "prediction_id" "uuid" NOT NULL,
    "state" "text" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_prediction_events_state_check" CHECK (("state" = ANY (ARRAY['armed_early'::"text", 'armed_refresh'::"text", 'committed'::"text", 'expired_no_event'::"text", 'missed_causal_window'::"text", 'aborted_config_change'::"text", 'tracking_response'::"text", 'scored'::"text"])))
);


ALTER TABLE "public"."rd_prediction_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_prediction_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "prediction_id" "uuid" NOT NULL,
    "outcome_id" "uuid" NOT NULL,
    "curve_mae" double precision,
    "peak_error" double precision,
    "time_to_peak_error_minutes" double precision,
    "integrated_response_error" double precision,
    "interval_coverage" double precision,
    "scored_horizons" integer NOT NULL,
    "scoring_version" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_prediction_scores_scored_horizons_check" CHECK (("scored_horizons" >= 0))
);


ALTER TABLE "public"."rd_prediction_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_prequential_scores_v5" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_model_version_id" "uuid" NOT NULL,
    "champion_model_version_id" "uuid" NOT NULL,
    "source_prediction_id" "uuid" NOT NULL,
    "irrigation_event_id" "uuid" NOT NULL,
    "event_finalization_id" "uuid" NOT NULL,
    "pairing_name" "text" NOT NULL,
    "opened_device_at" timestamp with time zone NOT NULL,
    "duration_source" "text" NOT NULL,
    "pulse_sequence_in_episode" integer NOT NULL,
    "outcome_evidence_fingerprint" "text" NOT NULL,
    "maturity" "text" NOT NULL,
    "evaluation_mode" "text" NOT NULL,
    "curve_mae" double precision,
    "peak_error" double precision,
    "time_to_peak_error_minutes" double precision,
    "integrated_response_error" double precision,
    "interval_coverage" double precision,
    "scored_horizons" integer NOT NULL,
    "scoring_version" "text" DEFAULT 'response-curve-v1'::"text" NOT NULL,
    "champion_curve_mae" double precision,
    "zero_curve_mae" double precision,
    "ood_score" double precision DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_prequential_scores_v5_duration_source_check" CHECK (("duration_source" = ANY (ARRAY['observed_event'::"text", 'configured_snapshot'::"text", 'unknown'::"text"]))),
    CONSTRAINT "rd_prequential_scores_v5_evaluation_mode_check" CHECK (("evaluation_mode" = 'frozen_model_causal_feature_replay'::"text")),
    CONSTRAINT "rd_prequential_scores_v5_maturity_check" CHECK (("maturity" = 'final'::"text")),
    CONSTRAINT "rd_prequential_scores_v5_ood_score_check" CHECK (("ood_score" >= (0)::double precision)),
    CONSTRAINT "rd_prequential_scores_v5_pulse_sequence_in_episode_check" CHECK (("pulse_sequence_in_episode" > 0)),
    CONSTRAINT "rd_prequential_scores_v5_scored_horizons_check" CHECK (("scored_horizons" > 0))
);


ALTER TABLE "public"."rd_prequential_scores_v5" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_prequential_scores_v5" IS 'Private final-only scores for a model frozen before the evaluated event.';



CREATE TABLE IF NOT EXISTS "public"."rd_response_horizons_v4" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "irrigation_event_id" "uuid" NOT NULL,
    "horizon_minute" integer NOT NULL,
    "target_device_at" timestamp with time zone NOT NULL,
    "state" "text" NOT NULL,
    "baseline_reading_id" bigint NOT NULL,
    "baseline_device_at" timestamp with time zone NOT NULL,
    "baseline_vwc" double precision NOT NULL,
    "outcome_reading_id" bigint,
    "outcome_device_at" timestamp with time zone,
    "outcome_vwc" double precision,
    "actual_delta" double precision,
    "censor_device_at" timestamp with time zone,
    "evidence_revision" integer NOT NULL,
    "supersedes_horizon_id" "uuid",
    "evidence_hash" "text" NOT NULL,
    "quality" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_response_horizons_v4_check" CHECK (((("state" = 'observed'::"text") AND ("outcome_reading_id" IS NOT NULL) AND ("outcome_device_at" IS NOT NULL) AND ("outcome_vwc" IS NOT NULL) AND ("actual_delta" IS NOT NULL) AND ("censor_device_at" IS NULL)) OR (("state" = 'right_censored'::"text") AND ("outcome_reading_id" IS NULL) AND ("outcome_device_at" IS NULL) AND ("outcome_vwc" IS NULL) AND ("actual_delta" IS NULL) AND ("censor_device_at" IS NOT NULL)) OR (("state" = 'missing_reading'::"text") AND ("outcome_reading_id" IS NULL) AND ("outcome_device_at" IS NULL) AND ("outcome_vwc" IS NULL) AND ("actual_delta" IS NULL) AND ("censor_device_at" IS NULL)))),
    CONSTRAINT "rd_response_horizons_v4_evidence_revision_check" CHECK (("evidence_revision" > 0)),
    CONSTRAINT "rd_response_horizons_v4_horizon_minute_check" CHECK (("horizon_minute" = ANY (ARRAY[0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240]))),
    CONSTRAINT "rd_response_horizons_v4_state_check" CHECK (("state" = ANY (ARRAY['observed'::"text", 'right_censored'::"text", 'missing_reading'::"text"])))
);


ALTER TABLE "public"."rd_response_horizons_v4" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_response_horizons_v4" IS 'Immutable per-pulse response evidence; each pulse is censored at the next pulse.';



CREATE TABLE IF NOT EXISTS "public"."rd_response_scores_v4" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "irrigation_event_id" "uuid" NOT NULL,
    "prediction_id" "uuid" NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "horizon_evidence_hash" "text" NOT NULL,
    "curve_mae" double precision,
    "peak_error" double precision,
    "time_to_peak_error_minutes" double precision,
    "integrated_response_error" double precision,
    "interval_coverage" double precision,
    "scored_horizons" integer NOT NULL,
    "scoring_version" "text" DEFAULT 'atomic-response-v4'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_response_scores_v4_scored_horizons_check" CHECK (("scored_horizons" > 0))
);


ALTER TABLE "public"."rd_response_scores_v4" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_shadow_model_channel_events_v5" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "model_version_id" "uuid" NOT NULL,
    "previous_model_version_id" "uuid",
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_shadow_model_channel_events_v5_event_type_check" CHECK (("event_type" = ANY (ARRAY['champion_pinned'::"text", 'challenger_published'::"text", 'shadow_promoted'::"text", 'candidate_rejected'::"text", 'evaluation_bound'::"text"])))
);


ALTER TABLE "public"."rd_shadow_model_channel_events_v5" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rd_shadow_model_channels_v5" (
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "champion_model_version_id" "uuid" NOT NULL,
    "evaluation_candidate_model_version_id" "uuid",
    "latest_challenger_model_version_id" "uuid",
    "champion_since" timestamp with time zone DEFAULT "now"() NOT NULL,
    "evaluation_started_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "rd_shadow_model_channels_v5_check" CHECK ((("evaluation_candidate_model_version_id" IS NULL) OR ("evaluation_started_at" IS NOT NULL)))
);


ALTER TABLE "public"."rd_shadow_model_channels_v5" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_shadow_model_channels_v5" IS 'Private pinned shadow champion and future-only V5 evaluation channel.';



CREATE TABLE IF NOT EXISTS "public"."rd_system_admin_access" (
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "granted_by" "uuid",
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone
);


ALTER TABLE "public"."rd_system_admin_access" OWNER TO "postgres";


COMMENT ON TABLE "public"."rd_system_admin_access" IS 'Explicit R&D Lab allowlist; independent from normal portal admin/researcher roles.';



CREATE TABLE IF NOT EXISTS "public"."rd_training_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "model_version_id" "uuid",
    "code_commit" "text" NOT NULL,
    "dataset_hash" "text" NOT NULL,
    "parameters" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "training_event_count" integer NOT NULL,
    "held_out_event_count" integer NOT NULL,
    "result" "text" NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "rd_training_runs_result_check" CHECK (("result" = ANY (ARRAY['running'::"text", 'succeeded'::"text", 'failed'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."rd_training_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sensor_readings" (
    "id" bigint NOT NULL,
    "event_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "source_sensor_id" integer,
    "sensor_key" "text",
    "pairing_name" "text",
    "device_recorded_at" timestamp with time zone NOT NULL,
    "server_received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "raw_value" double precision,
    "calibrated_value" double precision,
    "temperature" double precision,
    "electrical_conductivity" double precision,
    "unit" "text" DEFAULT 'vwc_pct'::"text" NOT NULL,
    "quality_flags" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."sensor_readings" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sensor_readings_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sensor_readings_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sensor_readings_id_seq" OWNED BY "public"."sensor_readings"."id";



CREATE TABLE IF NOT EXISTS "public"."sensors" (
    "id" bigint NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "source_sensor_id" integer NOT NULL,
    "sensor_key" "text" NOT NULL,
    "board_serial_id" "text" NOT NULL,
    "address" "text" NOT NULL,
    "label" "text" NOT NULL,
    "sensor_type" "text" DEFAULT 'SDI12'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sensors" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sensors_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sensors_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sensors_id_seq" OWNED BY "public"."sensors"."id";



CREATE TABLE IF NOT EXISTS "public"."software_terms_acceptances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "invite_id" "uuid",
    "email" "text" NOT NULL,
    "terms_version" "text" NOT NULL,
    "accepted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ip_address" "text",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "software_terms_acceptances_email_check" CHECK ((("char_length"(TRIM(BOTH FROM "email")) >= 3) AND ("char_length"(TRIM(BOTH FROM "email")) <= 200))),
    CONSTRAINT "software_terms_acceptances_email_lowercase" CHECK (("email" = "lower"(TRIM(BOTH FROM "email")))),
    CONSTRAINT "software_terms_acceptances_terms_version_check" CHECK ((("char_length"(TRIM(BOTH FROM "terms_version")) >= 1) AND ("char_length"(TRIM(BOTH FROM "terms_version")) <= 64)))
);


ALTER TABLE "public"."software_terms_acceptances" OWNER TO "postgres";


COMMENT ON TABLE "public"."software_terms_acceptances" IS 'Versioned click-through acceptance audit for exactH2O portal software access terms.';



CREATE TABLE IF NOT EXISTS "public"."support_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "project_id" "uuid" DEFAULT '22222222-2222-4222-8222-222222222222'::"uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "direction" "text" NOT NULL,
    "channel" "text" DEFAULT 'form'::"text" NOT NULL,
    "from_email" "text",
    "from_name" "text",
    "to_emails" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "cc_emails" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "subject" "text",
    "body_text" "text",
    "body_html" "text",
    "external_message_id" "text",
    "external_email_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "support_messages_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'form'::"text", 'portal'::"text", 'system'::"text"]))),
    CONSTRAINT "support_messages_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text", 'internal'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."support_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "project_id" "uuid" DEFAULT '22222222-2222-4222-8222-222222222222'::"uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "author_user_id" "uuid",
    "note" "text" NOT NULL,
    CONSTRAINT "support_notes_note_check" CHECK ((("char_length"(TRIM(BOTH FROM "note")) >= 1) AND ("char_length"(TRIM(BOTH FROM "note")) <= 4000)))
);


ALTER TABLE "public"."support_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" DEFAULT '22222222-2222-4222-8222-222222222222'::"uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_message_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" DEFAULT 'form'::"text" NOT NULL,
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "request_type" "text" DEFAULT 'support'::"text" NOT NULL,
    "subject" "text" NOT NULL,
    "customer_name" "text",
    "customer_email" "text" NOT NULL,
    "customer_phone" "text",
    "customer_organization" "text",
    "quote_request_id" "uuid",
    "external_thread_key" "text",
    "assigned_to" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_message_preview" "text",
    "last_message_from_email" "text",
    "last_message_subject" "text",
    "submission_fingerprint" "text",
    CONSTRAINT "support_threads_customer_email_check" CHECK ((("char_length"(TRIM(BOTH FROM "customer_email")) >= 3) AND ("char_length"(TRIM(BOTH FROM "customer_email")) <= 240))),
    CONSTRAINT "support_threads_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'urgent'::"text"]))),
    CONSTRAINT "support_threads_request_type_check" CHECK (("request_type" = ANY (ARRAY['support'::"text", 'quote'::"text", 'demo'::"text", 'docs'::"text", 'training'::"text", 'billing'::"text", 'install'::"text", 'other'::"text"]))),
    CONSTRAINT "support_threads_source_check" CHECK (("source" = ANY (ARRAY['email'::"text", 'form'::"text", 'quote'::"text", 'portal'::"text", 'other'::"text"]))),
    CONSTRAINT "support_threads_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'open'::"text", 'waiting_on_customer'::"text", 'quoted'::"text", 'won'::"text", 'lost'::"text", 'closed'::"text"]))),
    CONSTRAINT "support_threads_subject_check" CHECK ((("char_length"(TRIM(BOTH FROM "subject")) >= 1) AND ("char_length"(TRIM(BOTH FROM "subject")) <= 240)))
);


ALTER TABLE "public"."support_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."valve_events" (
    "id" bigint NOT NULL,
    "event_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "device_id" "text" NOT NULL,
    "source_valve_id" integer,
    "valve_key" "text",
    "pairing_name" "text",
    "action" "text" NOT NULL,
    "duration_ms" integer,
    "reason" "text",
    "device_recorded_at" timestamp with time zone NOT NULL,
    "server_received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "evidence_source" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "source_class" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "pairing_name_raw" "text",
    "pairing_resolved" boolean DEFAULT false NOT NULL,
    "quality_flags" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "valve_events_action_check" CHECK (("action" = ANY (ARRAY['open'::"text", 'close'::"text"]))),
    CONSTRAINT "valve_events_evidence_source_check" CHECK (("evidence_source" = ANY (ARRAY['owner_health_direct'::"text", 'owner_health_scalar'::"text", 'owner_health_history'::"text", 'unknown'::"text"]))),
    CONSTRAINT "valve_events_source_class_check" CHECK (("source_class" = ANY (ARRAY['automatic'::"text", 'manual'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."valve_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."valve_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."valve_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."valve_events_id_seq" OWNED BY "public"."valve_events"."id";



ALTER TABLE ONLY "public"."pairings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."pairings_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."sensor_readings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sensor_readings_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."sensors" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sensors_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."valve_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."valve_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."assistant_messages"
    ADD CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assistant_monitor_events"
    ADD CONSTRAINT "assistant_monitor_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assistant_monitors"
    ADD CONSTRAINT "assistant_monitors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assistant_monitors"
    ADD CONSTRAINT "assistant_monitors_project_id_created_by_review_token_hash_key" UNIQUE ("project_id", "created_by", "review_token_hash");



ALTER TABLE ONLY "public"."assistant_schedule_runs"
    ADD CONSTRAINT "assistant_schedule_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assistant_schedule_runs"
    ADD CONSTRAINT "assistant_schedule_runs_schedule_id_started_at_key" UNIQUE ("schedule_id", "started_at");



ALTER TABLE ONLY "public"."assistant_schedules"
    ADD CONSTRAINT "assistant_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assistant_schedules"
    ADD CONSTRAINT "assistant_schedules_project_id_created_by_review_token_hash_key" UNIQUE ("project_id", "created_by", "review_token_hash");



ALTER TABLE ONLY "public"."assistant_threads"
    ADD CONSTRAINT "assistant_threads_id_project_id_user_id_key" UNIQUE ("id", "project_id", "user_id");



ALTER TABLE ONLY "public"."assistant_threads"
    ADD CONSTRAINT "assistant_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calibration_candidates"
    ADD CONSTRAINT "calibration_candidates_id_study_id_project_id_key" UNIQUE ("id", "study_id", "project_id");



ALTER TABLE ONLY "public"."calibration_candidates"
    ADD CONSTRAINT "calibration_candidates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calibration_candidates"
    ADD CONSTRAINT "calibration_candidates_study_id_version_key" UNIQUE ("study_id", "version");



ALTER TABLE ONLY "public"."calibration_observations"
    ADD CONSTRAINT "calibration_observations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calibration_set_requests"
    ADD CONSTRAINT "calibration_set_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calibration_studies"
    ADD CONSTRAINT "calibration_studies_id_project_id_key" UNIQUE ("id", "project_id");



ALTER TABLE ONLY "public"."calibration_studies"
    ADD CONSTRAINT "calibration_studies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_config_state"
    ADD CONSTRAINT "device_config_state_pkey" PRIMARY KEY ("project_id", "device_id");



ALTER TABLE ONLY "public"."device_control_quarantines"
    ADD CONSTRAINT "device_control_quarantines_pkey" PRIMARY KEY ("project_id", "device_id");



ALTER TABLE ONLY "public"."device_control_tokens"
    ADD CONSTRAINT "device_control_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_control_tokens"
    ADD CONSTRAINT "device_control_tokens_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."device_health_snapshots"
    ADD CONSTRAINT "device_health_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_ingest_leases"
    ADD CONSTRAINT "device_ingest_leases_pkey" PRIMARY KEY ("project_id", "device_id");



ALTER TABLE ONLY "public"."device_maintenance_state"
    ADD CONSTRAINT "device_maintenance_state_pkey" PRIMARY KEY ("task_name");



ALTER TABLE ONLY "public"."device_runtime_state"
    ADD CONSTRAINT "device_runtime_state_pkey" PRIMARY KEY ("project_id", "device_id");



ALTER TABLE ONLY "public"."device_secrets"
    ADD CONSTRAINT "device_secrets_pkey" PRIMARY KEY ("device_id");



ALTER TABLE ONLY "public"."devices"
    ADD CONSTRAINT "devices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."experiment_assignments"
    ADD CONSTRAINT "experiment_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."experiment_assignments"
    ADD CONSTRAINT "experiment_assignments_revision_id_pairing_name_key" UNIQUE ("revision_id", "pairing_name");



ALTER TABLE ONLY "public"."experiment_audit_events"
    ADD CONSTRAINT "experiment_audit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."experiment_builder_requests"
    ADD CONSTRAINT "experiment_builder_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."experiment_control_plan_steps"
    ADD CONSTRAINT "experiment_control_plan_steps_client_request_id_key" UNIQUE ("client_request_id");



ALTER TABLE ONLY "public"."experiment_control_plan_steps"
    ADD CONSTRAINT "experiment_control_plan_steps_command_id_key" UNIQUE ("command_id");



ALTER TABLE ONLY "public"."experiment_control_plan_steps"
    ADD CONSTRAINT "experiment_control_plan_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."experiment_control_plan_steps"
    ADD CONSTRAINT "experiment_control_plan_steps_plan_id_sequence_key" UNIQUE ("plan_id", "sequence");



ALTER TABLE ONLY "public"."experiment_control_plans"
    ADD CONSTRAINT "experiment_control_plans_batch_id_key" UNIQUE ("batch_id");



ALTER TABLE ONLY "public"."experiment_control_plans"
    ADD CONSTRAINT "experiment_control_plans_experiment_id_id_key" UNIQUE ("experiment_id", "id");



ALTER TABLE ONLY "public"."experiment_control_plans"
    ADD CONSTRAINT "experiment_control_plans_id_project_id_key" UNIQUE ("id", "project_id");



ALTER TABLE ONLY "public"."experiment_control_plans"
    ADD CONSTRAINT "experiment_control_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."experiment_revisions"
    ADD CONSTRAINT "experiment_revisions_experiment_id_version_key" UNIQUE ("experiment_id", "version");



ALTER TABLE ONLY "public"."experiment_revisions"
    ADD CONSTRAINT "experiment_revisions_id_experiment_id_project_id_key" UNIQUE ("id", "experiment_id", "project_id");



ALTER TABLE ONLY "public"."experiment_revisions"
    ADD CONSTRAINT "experiment_revisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."experiments"
    ADD CONSTRAINT "experiments_id_project_id_key" UNIQUE ("id", "project_id");



ALTER TABLE ONLY "public"."experiments"
    ADD CONSTRAINT "experiments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."experiments"
    ADD CONSTRAINT "experiments_project_id_slug_key" UNIQUE ("project_id", "slug");



ALTER TABLE ONLY "public"."latest_device_state"
    ADD CONSTRAINT "latest_device_state_pkey" PRIMARY KEY ("device_id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."pairings"
    ADD CONSTRAINT "pairings_device_id_name_key" UNIQUE ("device_id", "name");



ALTER TABLE ONLY "public"."pairings"
    ADD CONSTRAINT "pairings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."portal_access"
    ADD CONSTRAINT "portal_access_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."portal_access"
    ADD CONSTRAINT "portal_access_project_id_user_id_key" UNIQUE ("project_id", "user_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_control_audit"
    ADD CONSTRAINT "project_control_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_control_commands"
    ADD CONSTRAINT "project_control_commands_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_invites"
    ADD CONSTRAINT "project_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_invites"
    ADD CONSTRAINT "project_invites_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id", "user_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."public_submission_rate_limits"
    ADD CONSTRAINT "public_submission_rate_limits_pkey" PRIMARY KEY ("scope", "client_hash", "window_started_at");



ALTER TABLE ONLY "public"."quote_requests"
    ADD CONSTRAINT "quote_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_access_audit"
    ADD CONSTRAINT "rd_access_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_correction_episodes_v2"
    ADD CONSTRAINT "rd_correction_episodes_v2_episode_key_key" UNIQUE ("episode_key");



ALTER TABLE ONLY "public"."rd_correction_episodes_v2"
    ADD CONSTRAINT "rd_correction_episodes_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_correction_episodes_v2"
    ADD CONSTRAINT "rd_correction_episodes_v2_project_id_device_id_first_open_e_key" UNIQUE ("project_id", "device_id", "first_open_event_id");



ALTER TABLE ONLY "public"."rd_curve_outcomes"
    ADD CONSTRAINT "rd_curve_outcomes_episode_id_key" UNIQUE ("episode_id");



ALTER TABLE ONLY "public"."rd_curve_outcomes"
    ADD CONSTRAINT "rd_curve_outcomes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_curve_predictions"
    ADD CONSTRAINT "rd_curve_predictions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_curve_predictions"
    ADD CONSTRAINT "rd_curve_predictions_prediction_key_key" UNIQUE ("prediction_key");



ALTER TABLE ONLY "public"."rd_episode_outcomes_v2"
    ADD CONSTRAINT "rd_episode_outcomes_v2_episode_id_key" UNIQUE ("episode_id");



ALTER TABLE ONLY "public"."rd_episode_outcomes_v2"
    ADD CONSTRAINT "rd_episode_outcomes_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_episode_outcomes_v3"
    ADD CONSTRAINT "rd_episode_outcomes_v3_episode_id_key" UNIQUE ("episode_id");



ALTER TABLE ONLY "public"."rd_episode_outcomes_v3"
    ADD CONSTRAINT "rd_episode_outcomes_v3_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_episode_scores_v2"
    ADD CONSTRAINT "rd_episode_scores_v2_episode_id_model_version_id_scoring_ve_key" UNIQUE ("episode_id", "model_version_id", "scoring_version");



ALTER TABLE ONLY "public"."rd_episode_scores_v2"
    ADD CONSTRAINT "rd_episode_scores_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_episode_scores_v3"
    ADD CONSTRAINT "rd_episode_scores_v3_episode_id_model_version_id_scoring_ve_key" UNIQUE ("episode_id", "model_version_id", "scoring_version");



ALTER TABLE ONLY "public"."rd_episode_scores_v3"
    ADD CONSTRAINT "rd_episode_scores_v3_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_evaluation_windows_v2"
    ADD CONSTRAINT "rd_evaluation_windows_v2_model_version_id_window_number_key" UNIQUE ("model_version_id", "window_number");



ALTER TABLE ONLY "public"."rd_evaluation_windows_v2"
    ADD CONSTRAINT "rd_evaluation_windows_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_event_attributions_v2"
    ADD CONSTRAINT "rd_event_attributions_v2_irrigation_event_id_model_version__key" UNIQUE ("irrigation_event_id", "model_version_id");



ALTER TABLE ONLY "public"."rd_event_attributions_v2"
    ADD CONSTRAINT "rd_event_attributions_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_event_exclusions_v4"
    ADD CONSTRAINT "rd_event_exclusions_v4_irrigation_event_id_key" UNIQUE ("irrigation_event_id");



ALTER TABLE ONLY "public"."rd_event_exclusions_v4"
    ADD CONSTRAINT "rd_event_exclusions_v4_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_event_finalizations_v5"
    ADD CONSTRAINT "rd_event_finalizations_v5_irrigation_event_id_evidence_fing_key" UNIQUE ("irrigation_event_id", "evidence_fingerprint");



ALTER TABLE ONLY "public"."rd_event_finalizations_v5"
    ADD CONSTRAINT "rd_event_finalizations_v5_irrigation_event_id_finalization__key" UNIQUE ("irrigation_event_id", "finalization_revision");



ALTER TABLE ONLY "public"."rd_event_finalizations_v5"
    ADD CONSTRAINT "rd_event_finalizations_v5_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_feature_snapshots_v4"
    ADD CONSTRAINT "rd_feature_snapshots_v4_irrigation_event_id_key" UNIQUE ("irrigation_event_id");



ALTER TABLE ONLY "public"."rd_feature_snapshots_v4"
    ADD CONSTRAINT "rd_feature_snapshots_v4_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_irrigation_episodes"
    ADD CONSTRAINT "rd_irrigation_episodes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_irrigation_episodes"
    ADD CONSTRAINT "rd_irrigation_episodes_project_id_device_id_first_open_even_key" UNIQUE ("project_id", "device_id", "first_open_event_id");



ALTER TABLE ONLY "public"."rd_irrigation_events_v2"
    ADD CONSTRAINT "rd_irrigation_events_v2_episode_id_sequence_in_episode_key" UNIQUE ("episode_id", "sequence_in_episode");



ALTER TABLE ONLY "public"."rd_irrigation_events_v2"
    ADD CONSTRAINT "rd_irrigation_events_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_irrigation_events_v2"
    ADD CONSTRAINT "rd_irrigation_events_v2_project_id_device_id_valve_event_id_key" UNIQUE ("project_id", "device_id", "valve_event_id");



ALTER TABLE ONLY "public"."rd_jobs"
    ADD CONSTRAINT "rd_jobs_job_key_key" UNIQUE ("job_key");



ALTER TABLE ONLY "public"."rd_jobs"
    ADD CONSTRAINT "rd_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_model_promotions"
    ADD CONSTRAINT "rd_model_promotions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_model_updates_v4"
    ADD CONSTRAINT "rd_model_updates_v4_evidence_fingerprint_key" UNIQUE ("evidence_fingerprint");



ALTER TABLE ONLY "public"."rd_model_updates_v4"
    ADD CONSTRAINT "rd_model_updates_v4_model_version_id_key" UNIQUE ("model_version_id");



ALTER TABLE ONLY "public"."rd_model_updates_v4"
    ADD CONSTRAINT "rd_model_updates_v4_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_model_updates_v5"
    ADD CONSTRAINT "rd_model_updates_v5_evidence_fingerprint_key" UNIQUE ("evidence_fingerprint");



ALTER TABLE ONLY "public"."rd_model_updates_v5"
    ADD CONSTRAINT "rd_model_updates_v5_model_version_id_key" UNIQUE ("model_version_id");



ALTER TABLE ONLY "public"."rd_model_updates_v5"
    ADD CONSTRAINT "rd_model_updates_v5_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_model_versions"
    ADD CONSTRAINT "rd_model_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_model_versions"
    ADD CONSTRAINT "rd_model_versions_version_key" UNIQUE ("version");



ALTER TABLE ONLY "public"."rd_observer_state"
    ADD CONSTRAINT "rd_observer_state_pkey" PRIMARY KEY ("project_id", "device_id", "pairing_name");



ALTER TABLE ONLY "public"."rd_pairing_adapters"
    ADD CONSTRAINT "rd_pairing_adapters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_pairing_adapters"
    ADD CONSTRAINT "rd_pairing_adapters_project_id_device_id_pairing_name_model_key" UNIQUE ("project_id", "device_id", "pairing_name", "model_version_id", "adapter_version");



ALTER TABLE ONLY "public"."rd_post_open_scores_v5"
    ADD CONSTRAINT "rd_post_open_scores_v5_candidate_model_version_id_irrigatio_key" UNIQUE ("candidate_model_version_id", "irrigation_event_id", "event_finalization_id", "observation_fingerprint");



ALTER TABLE ONLY "public"."rd_post_open_scores_v5"
    ADD CONSTRAINT "rd_post_open_scores_v5_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_prediction_events"
    ADD CONSTRAINT "rd_prediction_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_prediction_scores"
    ADD CONSTRAINT "rd_prediction_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_prediction_scores"
    ADD CONSTRAINT "rd_prediction_scores_prediction_id_key" UNIQUE ("prediction_id");



ALTER TABLE ONLY "public"."rd_prequential_scores_v5"
    ADD CONSTRAINT "rd_prequential_scores_v5_candidate_model_version_id_irrigat_key" UNIQUE ("candidate_model_version_id", "irrigation_event_id", "event_finalization_id");



ALTER TABLE ONLY "public"."rd_prequential_scores_v5"
    ADD CONSTRAINT "rd_prequential_scores_v5_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_response_horizons_v4"
    ADD CONSTRAINT "rd_response_horizons_v4_irrigation_event_id_horizon_minute__key" UNIQUE ("irrigation_event_id", "horizon_minute", "evidence_revision");



ALTER TABLE ONLY "public"."rd_response_horizons_v4"
    ADD CONSTRAINT "rd_response_horizons_v4_irrigation_event_id_horizon_minute_key1" UNIQUE ("irrigation_event_id", "horizon_minute", "evidence_hash");



ALTER TABLE ONLY "public"."rd_response_horizons_v4"
    ADD CONSTRAINT "rd_response_horizons_v4_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_response_scores_v4"
    ADD CONSTRAINT "rd_response_scores_v4_irrigation_event_id_prediction_id_hor_key" UNIQUE ("irrigation_event_id", "prediction_id", "horizon_evidence_hash", "scoring_version");



ALTER TABLE ONLY "public"."rd_response_scores_v4"
    ADD CONSTRAINT "rd_response_scores_v4_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_shadow_model_channel_events_v5"
    ADD CONSTRAINT "rd_shadow_model_channel_events_v5_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rd_shadow_model_channels_v5"
    ADD CONSTRAINT "rd_shadow_model_channels_v5_pkey" PRIMARY KEY ("project_id", "device_id");



ALTER TABLE ONLY "public"."rd_system_admin_access"
    ADD CONSTRAINT "rd_system_admin_access_pkey" PRIMARY KEY ("project_id", "user_id");



ALTER TABLE ONLY "public"."rd_training_runs"
    ADD CONSTRAINT "rd_training_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sensor_readings"
    ADD CONSTRAINT "sensor_readings_event_id_key" UNIQUE ("event_id");



ALTER TABLE ONLY "public"."sensor_readings"
    ADD CONSTRAINT "sensor_readings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sensors"
    ADD CONSTRAINT "sensors_device_id_sensor_key_key" UNIQUE ("device_id", "sensor_key");



ALTER TABLE ONLY "public"."sensors"
    ADD CONSTRAINT "sensors_device_id_source_sensor_id_key" UNIQUE ("device_id", "source_sensor_id");



ALTER TABLE ONLY "public"."sensors"
    ADD CONSTRAINT "sensors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."software_terms_acceptances"
    ADD CONSTRAINT "software_terms_acceptances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."software_terms_acceptances"
    ADD CONSTRAINT "software_terms_acceptances_user_version_unique" UNIQUE ("user_id", "terms_version");



ALTER TABLE ONLY "public"."support_messages"
    ADD CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_notes"
    ADD CONSTRAINT "support_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_threads"
    ADD CONSTRAINT "support_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_threads"
    ADD CONSTRAINT "support_threads_quote_request_id_key" UNIQUE ("quote_request_id");



ALTER TABLE ONLY "public"."valve_events"
    ADD CONSTRAINT "valve_events_event_id_key" UNIQUE ("event_id");



ALTER TABLE ONLY "public"."valve_events"
    ADD CONSTRAINT "valve_events_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "assistant_messages_request_role_unique" ON "public"."assistant_messages" USING "btree" ("thread_id", "request_id", "role") WHERE ("request_id" IS NOT NULL);



CREATE INDEX "assistant_messages_thread_created_idx" ON "public"."assistant_messages" USING "btree" ("thread_id", "created_at");



CREATE INDEX "assistant_monitor_events_project_idx" ON "public"."assistant_monitor_events" USING "btree" ("project_id", "created_at" DESC);



CREATE INDEX "assistant_monitors_due_idx" ON "public"."assistant_monitors" USING "btree" ("last_evaluated_at") WHERE ("status" = 'active'::"text");



CREATE INDEX "assistant_monitors_user_idx" ON "public"."assistant_monitors" USING "btree" ("project_id", "created_by", "created_at" DESC);



CREATE INDEX "assistant_schedule_runs_schedule_idx" ON "public"."assistant_schedule_runs" USING "btree" ("schedule_id", "started_at" DESC);



CREATE INDEX "assistant_schedules_due_idx" ON "public"."assistant_schedules" USING "btree" ("next_run_at") WHERE (("status" = 'active'::"text") AND ("next_run_at" IS NOT NULL));



CREATE INDEX "assistant_schedules_user_idx" ON "public"."assistant_schedules" USING "btree" ("project_id", "created_by", "created_at" DESC);



CREATE INDEX "assistant_threads_user_updated_idx" ON "public"."assistant_threads" USING "btree" ("project_id", "user_id", "updated_at" DESC);



CREATE INDEX "calibration_candidates_study_version_idx" ON "public"."calibration_candidates" USING "btree" ("study_id", "version" DESC);



CREATE INDEX "calibration_observations_study_time_idx" ON "public"."calibration_observations" USING "btree" ("study_id", "reference_recorded_at" DESC);



CREATE INDEX "calibration_set_requests_project_status_idx" ON "public"."calibration_set_requests" USING "btree" ("project_id", "status", "requested_at" DESC);



CREATE INDEX "calibration_studies_project_experiment_idx" ON "public"."calibration_studies" USING "btree" ("project_id", "experiment_id", "updated_at" DESC);



CREATE INDEX "device_config_state_updated_idx" ON "public"."device_config_state" USING "btree" ("project_id", "updated_at" DESC);



CREATE INDEX "device_control_tokens_project_device_idx" ON "public"."device_control_tokens" USING "btree" ("project_id", "device_id") WHERE (("enabled" = true) AND ("revoked_at" IS NULL));



CREATE INDEX "device_health_snapshots_captured_at_idx" ON "public"."device_health_snapshots" USING "btree" ("captured_at");



CREATE UNIQUE INDEX "device_health_snapshots_observation_idx" ON "public"."device_health_snapshots" USING "btree" ("project_id", "device_id", "observation_key") WHERE ("observation_key" IS NOT NULL);



CREATE INDEX "device_health_snapshots_project_device_captured_idx" ON "public"."device_health_snapshots" USING "btree" ("project_id", "device_id", "captured_at" DESC);



CREATE INDEX "device_runtime_state_updated_idx" ON "public"."device_runtime_state" USING "btree" ("project_id", "updated_at" DESC);



CREATE INDEX "experiment_assignments_experiment_pot_idx" ON "public"."experiment_assignments" USING "btree" ("experiment_id", "zone", "pot_number");



CREATE INDEX "experiment_audit_project_created_idx" ON "public"."experiment_audit_events" USING "btree" ("project_id", "created_at" DESC);



CREATE INDEX "experiment_builder_requests_user_created_idx" ON "public"."experiment_builder_requests" USING "btree" ("project_id", "user_id", "created_at" DESC);



CREATE INDEX "experiment_control_plan_steps_plan_idx" ON "public"."experiment_control_plan_steps" USING "btree" ("plan_id", "sequence");



CREATE INDEX "experiment_control_plans_project_idx" ON "public"."experiment_control_plans" USING "btree" ("project_id", "created_at" DESC);



CREATE INDEX "experiment_revisions_experiment_version_idx" ON "public"."experiment_revisions" USING "btree" ("experiment_id", "version" DESC);



CREATE INDEX "experiments_project_status_idx" ON "public"."experiments" USING "btree" ("project_id", "status", "updated_at" DESC);



CREATE INDEX "pairings_project_pot_idx" ON "public"."pairings" USING "btree" ("project_id", "pot_number");



CREATE INDEX "portal_access_project_role_idx" ON "public"."portal_access" USING "btree" ("project_id", "role");



CREATE INDEX "portal_access_user_project_idx" ON "public"."portal_access" USING "btree" ("user_id", "project_id");



CREATE INDEX "project_control_audit_project_created_idx" ON "public"."project_control_audit" USING "btree" ("project_id", "created_at" DESC);



CREATE INDEX "project_control_commands_batch_idx" ON "public"."project_control_commands" USING "btree" ("batch_id", "requested_at") WHERE ("batch_id" IS NOT NULL);



CREATE UNIQUE INDEX "project_control_commands_client_request_idx" ON "public"."project_control_commands" USING "btree" ("project_id", "requested_by", "client_request_id") WHERE ("client_request_id" IS NOT NULL);



CREATE INDEX "project_control_commands_dependency_idx" ON "public"."project_control_commands" USING "btree" ("depends_on_command_id") WHERE ("depends_on_command_id" IS NOT NULL);



CREATE INDEX "project_control_commands_device_status_idx" ON "public"."project_control_commands" USING "btree" ("device_id", "status", "requested_at") WHERE ("status" = ANY (ARRAY['queued'::"text", 'accepted'::"text", 'running'::"text"]));



CREATE INDEX "project_control_commands_project_status_idx" ON "public"."project_control_commands" USING "btree" ("project_id", "status", "requested_at" DESC);



CREATE INDEX "project_control_commands_requested_by_idx" ON "public"."project_control_commands" USING "btree" ("requested_by", "requested_at" DESC);



CREATE INDEX "project_control_commands_running_lease_idx" ON "public"."project_control_commands" USING "btree" ("lease_expires_at") WHERE ("status" = 'running'::"text");



CREATE INDEX "project_invites_expires_at_idx" ON "public"."project_invites" USING "btree" ("expires_at") WHERE ("accepted_at" IS NULL);



CREATE INDEX "project_invites_project_email_idx" ON "public"."project_invites" USING "btree" ("project_id", "email");



CREATE INDEX "public_submission_rate_limits_window_idx" ON "public"."public_submission_rate_limits" USING "btree" ("window_started_at");



CREATE INDEX "quote_requests_created_at_idx" ON "public"."quote_requests" USING "btree" ("created_at" DESC);



CREATE INDEX "quote_requests_notification_status_idx" ON "public"."quote_requests" USING "btree" ("notification_status", "created_at" DESC);



CREATE INDEX "quote_requests_project_status_created_idx" ON "public"."quote_requests" USING "btree" ("project_id", "status", "created_at" DESC);



CREATE INDEX "quote_requests_submission_fingerprint_idx" ON "public"."quote_requests" USING "btree" ("submission_fingerprint", "created_at" DESC) WHERE ("submission_fingerprint" IS NOT NULL);



CREATE INDEX "rd_correction_episodes_v2_active_idx" ON "public"."rd_correction_episodes_v2" USING "btree" ("project_id", "status", "last_open_device_at" DESC) WHERE ("status" = ANY (ARRAY['active'::"text", 'observing'::"text"]));



CREATE INDEX "rd_correction_episodes_v2_pairing_idx" ON "public"."rd_correction_episodes_v2" USING "btree" ("project_id", "device_id", "pairing_name", "first_open_device_at" DESC);



CREATE INDEX "rd_episode_outcomes_v2_training_idx" ON "public"."rd_episode_outcomes_v2" USING "btree" ("project_id", "completed_at", "pairing_name") WHERE ("eligible_for_training" = true);



CREATE INDEX "rd_episode_outcomes_v3_training_idx" ON "public"."rd_episode_outcomes_v3" USING "btree" ("project_id", "completed_at", "pairing_name") WHERE ("eligible_for_training" = true);



CREATE INDEX "rd_episode_scores_v2_model_idx" ON "public"."rd_episode_scores_v2" USING "btree" ("model_version_id", "created_at" DESC);



CREATE INDEX "rd_episodes_pairing_time_idx" ON "public"."rd_irrigation_episodes" USING "btree" ("project_id", "device_id", "pairing_name", "first_open_device_at" DESC);



CREATE INDEX "rd_event_finalizations_v5_project_time_idx" ON "public"."rd_event_finalizations_v5" USING "btree" ("project_id", "pairing_name", "opened_device_at", "finalization_revision" DESC);



CREATE INDEX "rd_feature_snapshots_v4_time_idx" ON "public"."rd_feature_snapshots_v4" USING "btree" ("project_id", "pairing_name", "opened_device_at", "irrigation_event_id");



CREATE INDEX "rd_irrigation_events_v2_pairing_time_idx" ON "public"."rd_irrigation_events_v2" USING "btree" ("project_id", "device_id", "pairing_name", "opened_device_at" DESC);



CREATE UNIQUE INDEX "rd_irrigation_events_v2_prediction_idx" ON "public"."rd_irrigation_events_v2" USING "btree" ("prediction_id") WHERE ("prediction_id" IS NOT NULL);



CREATE INDEX "rd_jobs_claim_idx" ON "public"."rd_jobs" USING "btree" ("available_at", "created_at") WHERE ("status" = 'queued'::"text");



CREATE UNIQUE INDEX "rd_one_champion_idx" ON "public"."rd_model_versions" USING "btree" ("status") WHERE ("status" = 'champion'::"text");



CREATE UNIQUE INDEX "rd_one_provisional_atomic_v4_idx" ON "public"."rd_model_versions" USING "btree" ("feature_schema_version") WHERE (("feature_schema_version" = 'atomic-response-v4'::"text") AND ("status" = 'candidate'::"text"));



CREATE INDEX "rd_post_open_scores_v5_candidate_time_idx" ON "public"."rd_post_open_scores_v5" USING "btree" ("candidate_model_version_id", "opened_device_at", "pairing_name");



CREATE INDEX "rd_prediction_events_latest_idx" ON "public"."rd_prediction_events" USING "btree" ("prediction_id", "occurred_at" DESC);



CREATE INDEX "rd_predictions_pairing_time_idx" ON "public"."rd_curve_predictions" USING "btree" ("project_id", "device_id", "pairing_name", "feature_as_of_device_at" DESC);



CREATE INDEX "rd_predictions_project_time_idx" ON "public"."rd_curve_predictions" USING "btree" ("project_id", "issued_at" DESC);



CREATE INDEX "rd_prequential_scores_v5_candidate_time_idx" ON "public"."rd_prequential_scores_v5" USING "btree" ("candidate_model_version_id", "opened_device_at", "pairing_name");



CREATE INDEX "rd_response_horizons_v4_latest_idx" ON "public"."rd_response_horizons_v4" USING "btree" ("irrigation_event_id", "horizon_minute", "evidence_revision" DESC);



CREATE UNIQUE INDEX "rd_single_champion_model_idx" ON "public"."rd_model_versions" USING "btree" ("status") WHERE ("status" = 'champion'::"text");



CREATE INDEX "sensor_readings_device_time_idx" ON "public"."sensor_readings" USING "btree" ("device_id", "device_recorded_at" DESC);



CREATE INDEX "sensor_readings_event_id_idx" ON "public"."sensor_readings" USING "btree" ("event_id");



CREATE INDEX "sensor_readings_project_device_received_idx" ON "public"."sensor_readings" USING "btree" ("project_id", "device_id", "server_received_at" DESC, "id" DESC);



CREATE INDEX "sensor_readings_project_device_recorded_idx" ON "public"."sensor_readings" USING "btree" ("project_id", "device_id", "device_recorded_at" DESC, "id" DESC);



CREATE INDEX "sensor_readings_project_pairing_recorded_idx" ON "public"."sensor_readings" USING "btree" ("project_id", "pairing_name", "device_recorded_at" DESC, "id" DESC);



CREATE INDEX "sensor_readings_project_time_idx" ON "public"."sensor_readings" USING "btree" ("project_id", "device_recorded_at" DESC);



CREATE INDEX "software_terms_acceptances_email_idx" ON "public"."software_terms_acceptances" USING "btree" ("email");



CREATE INDEX "software_terms_acceptances_project_idx" ON "public"."software_terms_acceptances" USING "btree" ("project_id", "accepted_at" DESC);



CREATE UNIQUE INDEX "support_messages_external_email_idx" ON "public"."support_messages" USING "btree" ("external_email_id") WHERE ("external_email_id" IS NOT NULL);



CREATE UNIQUE INDEX "support_messages_external_message_idx" ON "public"."support_messages" USING "btree" ("external_message_id") WHERE ("external_message_id" IS NOT NULL);



CREATE INDEX "support_messages_thread_created_idx" ON "public"."support_messages" USING "btree" ("thread_id", "created_at");



CREATE INDEX "support_notes_thread_created_idx" ON "public"."support_notes" USING "btree" ("thread_id", "created_at" DESC);



CREATE INDEX "support_threads_customer_email_idx" ON "public"."support_threads" USING "btree" ("lower"("customer_email"));



CREATE INDEX "support_threads_project_status_last_message_idx" ON "public"."support_threads" USING "btree" ("project_id", "status", "last_message_at" DESC);



CREATE INDEX "support_threads_submission_fingerprint_idx" ON "public"."support_threads" USING "btree" ("submission_fingerprint", "created_at" DESC) WHERE ("submission_fingerprint" IS NOT NULL);



CREATE INDEX "valve_events_project_time_idx" ON "public"."valve_events" USING "btree" ("project_id", "device_recorded_at" DESC);



CREATE INDEX "valve_events_rd_observer_idx" ON "public"."valve_events" USING "btree" ("project_id", "device_id", "device_recorded_at", "id");



CREATE OR REPLACE TRIGGER "calibration_observations_touch_updated_at" BEFORE UPDATE ON "public"."calibration_observations" FOR EACH ROW EXECUTE FUNCTION "public"."touch_calibration_study_updated_at"();



CREATE OR REPLACE TRIGGER "calibration_studies_touch_updated_at" BEFORE UPDATE ON "public"."calibration_studies" FOR EACH ROW EXECUTE FUNCTION "public"."touch_calibration_study_updated_at"();



CREATE OR REPLACE TRIGGER "project_invites_apply_membership_after_accept" AFTER UPDATE OF "accepted_at", "accepted_by" ON "public"."project_invites" FOR EACH ROW WHEN ((("new"."accepted_at" IS NOT NULL) AND ("new"."accepted_by" IS NOT NULL))) EXECUTE FUNCTION "public"."apply_project_invite_membership"();



CREATE OR REPLACE TRIGGER "rd_committed_prediction_causality" BEFORE INSERT ON "public"."rd_prediction_events" FOR EACH ROW EXECUTE FUNCTION "public"."rd_enforce_committed_prediction_causality"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_curve_outcomes" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_curve_predictions" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_episode_outcomes_v2" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_episode_outcomes_v3" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_episode_scores_v2" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_episode_scores_v3" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_evaluation_windows_v2" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_event_attributions_v2" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_event_exclusions_v4" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_event_finalizations_v5" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_feature_snapshots_v4" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_irrigation_events_v2" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_model_promotions" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_model_updates_v4" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_model_updates_v5" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_post_open_scores_v5" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_prediction_events" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_prediction_scores" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_prequential_scores_v5" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_response_horizons_v4" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_response_scores_v4" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_shadow_model_channel_events_v5" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_immutable_guard" BEFORE DELETE OR UPDATE ON "public"."rd_training_runs" FOR EACH ROW EXECUTE FUNCTION "public"."rd_block_immutable_mutation"();



CREATE OR REPLACE TRIGGER "rd_model_status_guard" BEFORE INSERT OR UPDATE OF "status" ON "public"."rd_model_versions" FOR EACH ROW EXECUTE FUNCTION "public"."rd_guard_model_status_change"();



CREATE OR REPLACE TRIGGER "reconcile_experiment_control_command_trigger" AFTER UPDATE OF "status" ON "public"."project_control_commands" FOR EACH ROW WHEN (("old"."status" IS DISTINCT FROM "new"."status")) EXECUTE FUNCTION "public"."reconcile_experiment_control_command"();



CREATE OR REPLACE TRIGGER "touch_support_thread_from_message" AFTER INSERT ON "public"."support_messages" FOR EACH ROW EXECUTE FUNCTION "public"."touch_support_thread_from_message"();



ALTER TABLE ONLY "public"."assistant_messages"
    ADD CONSTRAINT "assistant_messages_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."experiment_builder_requests"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."assistant_messages"
    ADD CONSTRAINT "assistant_messages_thread_id_project_id_user_id_fkey" FOREIGN KEY ("thread_id", "project_id", "user_id") REFERENCES "public"."assistant_threads"("id", "project_id", "user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assistant_monitor_events"
    ADD CONSTRAINT "assistant_monitor_events_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "public"."assistant_monitors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assistant_monitor_events"
    ADD CONSTRAINT "assistant_monitor_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assistant_monitors"
    ADD CONSTRAINT "assistant_monitors_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."assistant_monitors"
    ADD CONSTRAINT "assistant_monitors_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assistant_monitors"
    ADD CONSTRAINT "assistant_monitors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assistant_schedule_runs"
    ADD CONSTRAINT "assistant_schedule_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assistant_schedule_runs"
    ADD CONSTRAINT "assistant_schedule_runs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."assistant_schedules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assistant_schedules"
    ADD CONSTRAINT "assistant_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."assistant_schedules"
    ADD CONSTRAINT "assistant_schedules_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."assistant_schedules"
    ADD CONSTRAINT "assistant_schedules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assistant_threads"
    ADD CONSTRAINT "assistant_threads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assistant_threads"
    ADD CONSTRAINT "assistant_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calibration_candidates"
    ADD CONSTRAINT "calibration_candidates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."calibration_candidates"
    ADD CONSTRAINT "calibration_candidates_study_id_project_id_fkey" FOREIGN KEY ("study_id", "project_id") REFERENCES "public"."calibration_studies"("id", "project_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calibration_observations"
    ADD CONSTRAINT "calibration_observations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."calibration_observations"
    ADD CONSTRAINT "calibration_observations_study_id_project_id_fkey" FOREIGN KEY ("study_id", "project_id") REFERENCES "public"."calibration_studies"("id", "project_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calibration_set_requests"
    ADD CONSTRAINT "calibration_set_requests_candidate_id_study_id_project_id_fkey" FOREIGN KEY ("candidate_id", "study_id", "project_id") REFERENCES "public"."calibration_candidates"("id", "study_id", "project_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."calibration_set_requests"
    ADD CONSTRAINT "calibration_set_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."calibration_set_requests"
    ADD CONSTRAINT "calibration_set_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."calibration_set_requests"
    ADD CONSTRAINT "calibration_set_requests_study_id_project_id_fkey" FOREIGN KEY ("study_id", "project_id") REFERENCES "public"."calibration_studies"("id", "project_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."calibration_studies"
    ADD CONSTRAINT "calibration_studies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."calibration_studies"
    ADD CONSTRAINT "calibration_studies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_control_quarantines"
    ADD CONSTRAINT "device_control_quarantines_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "public"."project_control_commands"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."device_secrets"
    ADD CONSTRAINT "device_secrets_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."devices"
    ADD CONSTRAINT "devices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."devices"
    ADD CONSTRAINT "devices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiment_assignments"
    ADD CONSTRAINT "experiment_assignments_revision_id_experiment_id_project_i_fkey" FOREIGN KEY ("revision_id", "experiment_id", "project_id") REFERENCES "public"."experiment_revisions"("id", "experiment_id", "project_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiment_audit_events"
    ADD CONSTRAINT "experiment_audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."experiment_audit_events"
    ADD CONSTRAINT "experiment_audit_events_experiment_id_project_id_fkey" FOREIGN KEY ("experiment_id", "project_id") REFERENCES "public"."experiments"("id", "project_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiment_builder_requests"
    ADD CONSTRAINT "experiment_builder_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiment_builder_requests"
    ADD CONSTRAINT "experiment_builder_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiment_control_plan_steps"
    ADD CONSTRAINT "experiment_control_plan_steps_command_fk" FOREIGN KEY ("command_id") REFERENCES "public"."project_control_commands"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."experiment_control_plan_steps"
    ADD CONSTRAINT "experiment_control_plan_steps_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."experiment_control_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiment_control_plan_steps"
    ADD CONSTRAINT "experiment_control_plan_steps_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiment_control_plans"
    ADD CONSTRAINT "experiment_control_plans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."experiment_control_plans"
    ADD CONSTRAINT "experiment_control_plans_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiment_control_plans"
    ADD CONSTRAINT "experiment_control_plans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiment_revisions"
    ADD CONSTRAINT "experiment_revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."experiment_revisions"
    ADD CONSTRAINT "experiment_revisions_experiment_id_project_id_fkey" FOREIGN KEY ("experiment_id", "project_id") REFERENCES "public"."experiments"("id", "project_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."experiments"
    ADD CONSTRAINT "experiments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."experiments"
    ADD CONSTRAINT "experiments_current_revision_fk" FOREIGN KEY ("current_revision_id", "id", "project_id") REFERENCES "public"."experiment_revisions"("id", "experiment_id", "project_id") DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "public"."experiments"
    ADD CONSTRAINT "experiments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."latest_device_state"
    ADD CONSTRAINT "latest_device_state_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."latest_device_state"
    ADD CONSTRAINT "latest_device_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."latest_device_state"
    ADD CONSTRAINT "latest_device_state_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pairings"
    ADD CONSTRAINT "pairings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pairings"
    ADD CONSTRAINT "pairings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."portal_access"
    ADD CONSTRAINT "portal_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_control_audit"
    ADD CONSTRAINT "project_control_audit_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_control_audit"
    ADD CONSTRAINT "project_control_audit_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "public"."project_control_commands"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_control_commands"
    ADD CONSTRAINT "project_control_commands_dependency_fk" FOREIGN KEY ("depends_on_command_id") REFERENCES "public"."project_control_commands"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_control_commands"
    ADD CONSTRAINT "project_control_commands_experiment_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_control_commands"
    ADD CONSTRAINT "project_control_commands_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rd_access_audit"
    ADD CONSTRAINT "rd_access_audit_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rd_curve_outcomes"
    ADD CONSTRAINT "rd_curve_outcomes_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "public"."rd_irrigation_episodes"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_curve_predictions"
    ADD CONSTRAINT "rd_curve_predictions_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "public"."rd_irrigation_episodes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rd_curve_predictions"
    ADD CONSTRAINT "rd_curve_predictions_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id");



ALTER TABLE ONLY "public"."rd_episode_outcomes_v2"
    ADD CONSTRAINT "rd_episode_outcomes_v2_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "public"."rd_correction_episodes_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_episode_outcomes_v3"
    ADD CONSTRAINT "rd_episode_outcomes_v3_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "public"."rd_correction_episodes_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_episode_scores_v2"
    ADD CONSTRAINT "rd_episode_scores_v2_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "public"."rd_correction_episodes_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_episode_scores_v2"
    ADD CONSTRAINT "rd_episode_scores_v2_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_episode_scores_v2"
    ADD CONSTRAINT "rd_episode_scores_v2_outcome_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "public"."rd_episode_outcomes_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_episode_scores_v3"
    ADD CONSTRAINT "rd_episode_scores_v3_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "public"."rd_correction_episodes_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_episode_scores_v3"
    ADD CONSTRAINT "rd_episode_scores_v3_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_episode_scores_v3"
    ADD CONSTRAINT "rd_episode_scores_v3_outcome_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "public"."rd_episode_outcomes_v3"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_evaluation_windows_v2"
    ADD CONSTRAINT "rd_evaluation_windows_v2_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_event_attributions_v2"
    ADD CONSTRAINT "rd_event_attributions_v2_irrigation_event_id_fkey" FOREIGN KEY ("irrigation_event_id") REFERENCES "public"."rd_irrigation_events_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_event_attributions_v2"
    ADD CONSTRAINT "rd_event_attributions_v2_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_event_exclusions_v4"
    ADD CONSTRAINT "rd_event_exclusions_v4_irrigation_event_id_fkey" FOREIGN KEY ("irrigation_event_id") REFERENCES "public"."rd_irrigation_events_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_event_finalizations_v5"
    ADD CONSTRAINT "rd_event_finalizations_v5_irrigation_event_id_fkey" FOREIGN KEY ("irrigation_event_id") REFERENCES "public"."rd_irrigation_events_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_event_finalizations_v5"
    ADD CONSTRAINT "rd_event_finalizations_v5_supersedes_finalization_id_fkey" FOREIGN KEY ("supersedes_finalization_id") REFERENCES "public"."rd_event_finalizations_v5"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_feature_snapshots_v4"
    ADD CONSTRAINT "rd_feature_snapshots_v4_irrigation_event_id_fkey" FOREIGN KEY ("irrigation_event_id") REFERENCES "public"."rd_irrigation_events_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_irrigation_events_v2"
    ADD CONSTRAINT "rd_irrigation_events_v2_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "public"."rd_correction_episodes_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_irrigation_events_v2"
    ADD CONSTRAINT "rd_irrigation_events_v2_prediction_id_fkey" FOREIGN KEY ("prediction_id") REFERENCES "public"."rd_curve_predictions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_model_promotions"
    ADD CONSTRAINT "rd_model_promotions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rd_model_promotions"
    ADD CONSTRAINT "rd_model_promotions_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id");



ALTER TABLE ONLY "public"."rd_model_promotions"
    ADD CONSTRAINT "rd_model_promotions_previous_model_version_id_fkey" FOREIGN KEY ("previous_model_version_id") REFERENCES "public"."rd_model_versions"("id");



ALTER TABLE ONLY "public"."rd_model_updates_v4"
    ADD CONSTRAINT "rd_model_updates_v4_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_model_updates_v4"
    ADD CONSTRAINT "rd_model_updates_v4_previous_model_version_id_fkey" FOREIGN KEY ("previous_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_model_updates_v5"
    ADD CONSTRAINT "rd_model_updates_v5_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_model_updates_v5"
    ADD CONSTRAINT "rd_model_updates_v5_previous_model_version_id_fkey" FOREIGN KEY ("previous_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_observer_state"
    ADD CONSTRAINT "rd_observer_state_active_episode_id_fkey" FOREIGN KEY ("active_episode_id") REFERENCES "public"."rd_irrigation_episodes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rd_observer_state"
    ADD CONSTRAINT "rd_observer_state_active_prediction_id_fkey" FOREIGN KEY ("active_prediction_id") REFERENCES "public"."rd_curve_predictions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rd_pairing_adapters"
    ADD CONSTRAINT "rd_pairing_adapters_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id");



ALTER TABLE ONLY "public"."rd_post_open_scores_v5"
    ADD CONSTRAINT "rd_post_open_scores_v5_candidate_model_version_id_fkey" FOREIGN KEY ("candidate_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_post_open_scores_v5"
    ADD CONSTRAINT "rd_post_open_scores_v5_champion_model_version_id_fkey" FOREIGN KEY ("champion_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_post_open_scores_v5"
    ADD CONSTRAINT "rd_post_open_scores_v5_event_finalization_id_fkey" FOREIGN KEY ("event_finalization_id") REFERENCES "public"."rd_event_finalizations_v5"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_post_open_scores_v5"
    ADD CONSTRAINT "rd_post_open_scores_v5_irrigation_event_id_fkey" FOREIGN KEY ("irrigation_event_id") REFERENCES "public"."rd_irrigation_events_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_post_open_scores_v5"
    ADD CONSTRAINT "rd_post_open_scores_v5_source_prediction_id_fkey" FOREIGN KEY ("source_prediction_id") REFERENCES "public"."rd_curve_predictions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_prediction_events"
    ADD CONSTRAINT "rd_prediction_events_prediction_id_fkey" FOREIGN KEY ("prediction_id") REFERENCES "public"."rd_curve_predictions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_prediction_scores"
    ADD CONSTRAINT "rd_prediction_scores_outcome_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "public"."rd_curve_outcomes"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_prediction_scores"
    ADD CONSTRAINT "rd_prediction_scores_prediction_id_fkey" FOREIGN KEY ("prediction_id") REFERENCES "public"."rd_curve_predictions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_prequential_scores_v5"
    ADD CONSTRAINT "rd_prequential_scores_v5_candidate_model_version_id_fkey" FOREIGN KEY ("candidate_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_prequential_scores_v5"
    ADD CONSTRAINT "rd_prequential_scores_v5_champion_model_version_id_fkey" FOREIGN KEY ("champion_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_prequential_scores_v5"
    ADD CONSTRAINT "rd_prequential_scores_v5_event_finalization_id_fkey" FOREIGN KEY ("event_finalization_id") REFERENCES "public"."rd_event_finalizations_v5"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_prequential_scores_v5"
    ADD CONSTRAINT "rd_prequential_scores_v5_irrigation_event_id_fkey" FOREIGN KEY ("irrigation_event_id") REFERENCES "public"."rd_irrigation_events_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_prequential_scores_v5"
    ADD CONSTRAINT "rd_prequential_scores_v5_source_prediction_id_fkey" FOREIGN KEY ("source_prediction_id") REFERENCES "public"."rd_curve_predictions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_response_horizons_v4"
    ADD CONSTRAINT "rd_response_horizons_v4_irrigation_event_id_fkey" FOREIGN KEY ("irrigation_event_id") REFERENCES "public"."rd_irrigation_events_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_response_horizons_v4"
    ADD CONSTRAINT "rd_response_horizons_v4_supersedes_horizon_id_fkey" FOREIGN KEY ("supersedes_horizon_id") REFERENCES "public"."rd_response_horizons_v4"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_response_scores_v4"
    ADD CONSTRAINT "rd_response_scores_v4_irrigation_event_id_fkey" FOREIGN KEY ("irrigation_event_id") REFERENCES "public"."rd_irrigation_events_v2"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_response_scores_v4"
    ADD CONSTRAINT "rd_response_scores_v4_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_response_scores_v4"
    ADD CONSTRAINT "rd_response_scores_v4_prediction_id_fkey" FOREIGN KEY ("prediction_id") REFERENCES "public"."rd_curve_predictions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_shadow_model_channel_events_v5"
    ADD CONSTRAINT "rd_shadow_model_channel_events_v5_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_shadow_model_channel_events_v5"
    ADD CONSTRAINT "rd_shadow_model_channel_events_v_previous_model_version_id_fkey" FOREIGN KEY ("previous_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_shadow_model_channels_v5"
    ADD CONSTRAINT "rd_shadow_model_channels_v5_champion_model_version_id_fkey" FOREIGN KEY ("champion_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_shadow_model_channels_v5"
    ADD CONSTRAINT "rd_shadow_model_channels_v5_evaluation_candidate_model_ver_fkey" FOREIGN KEY ("evaluation_candidate_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_shadow_model_channels_v5"
    ADD CONSTRAINT "rd_shadow_model_channels_v5_latest_challenger_model_versio_fkey" FOREIGN KEY ("latest_challenger_model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."rd_system_admin_access"
    ADD CONSTRAINT "rd_system_admin_access_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."rd_system_admin_access"
    ADD CONSTRAINT "rd_system_admin_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rd_training_runs"
    ADD CONSTRAINT "rd_training_runs_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "public"."rd_model_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sensor_readings"
    ADD CONSTRAINT "sensor_readings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sensor_readings"
    ADD CONSTRAINT "sensor_readings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sensor_readings"
    ADD CONSTRAINT "sensor_readings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sensors"
    ADD CONSTRAINT "sensors_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sensors"
    ADD CONSTRAINT "sensors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."software_terms_acceptances"
    ADD CONSTRAINT "software_terms_acceptances_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "public"."project_invites"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."software_terms_acceptances"
    ADD CONSTRAINT "software_terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_messages"
    ADD CONSTRAINT "support_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_notes"
    ADD CONSTRAINT "support_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."support_notes"
    ADD CONSTRAINT "support_notes_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_threads"
    ADD CONSTRAINT "support_threads_quote_request_id_fkey" FOREIGN KEY ("quote_request_id") REFERENCES "public"."quote_requests"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."valve_events"
    ADD CONSTRAINT "valve_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."valve_events"
    ADD CONSTRAINT "valve_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."valve_events"
    ADD CONSTRAINT "valve_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



CREATE POLICY "Members can read valve events" ON "public"."valve_events" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "member_project_ids"."allowed_project_id"
   FROM "public"."member_project_ids"() "member_project_ids"("allowed_project_id"))));



CREATE POLICY "Portal admins can add support notes" ON "public"."support_notes" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_portal_admin"("project_id") AND ("author_user_id" = "auth"."uid"())));



CREATE POLICY "Portal admins can read device health snapshots" ON "public"."device_health_snapshots" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "portal_admin_project_ids"."allowed_project_id"
   FROM "public"."portal_admin_project_ids"() "portal_admin_project_ids"("allowed_project_id"))));



CREATE POLICY "Portal admins can read quote requests" ON "public"."quote_requests" FOR SELECT TO "authenticated" USING ("public"."is_portal_admin"("project_id"));



CREATE POLICY "Portal admins can read support messages" ON "public"."support_messages" FOR SELECT TO "authenticated" USING ("public"."is_portal_admin"("project_id"));



CREATE POLICY "Portal admins can read support notes" ON "public"."support_notes" FOR SELECT TO "authenticated" USING ("public"."is_portal_admin"("project_id"));



CREATE POLICY "Portal admins can read support threads" ON "public"."support_threads" FOR SELECT TO "authenticated" USING ("public"."is_portal_admin"("project_id"));



CREATE POLICY "Portal admins can update quote requests" ON "public"."quote_requests" FOR UPDATE TO "authenticated" USING ("public"."is_portal_admin"("project_id")) WITH CHECK ("public"."is_portal_admin"("project_id"));



CREATE POLICY "Portal admins can update support threads" ON "public"."support_threads" FOR UPDATE TO "authenticated" USING ("public"."is_portal_admin"("project_id")) WITH CHECK ("public"."is_portal_admin"("project_id"));



CREATE POLICY "Portal members can read control audit" ON "public"."project_control_audit" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "portal_project_ids"."allowed_project_id"
   FROM "public"."portal_project_ids"() "portal_project_ids"("allowed_project_id"))));



CREATE POLICY "Portal members can read control commands" ON "public"."project_control_commands" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "portal_project_ids"."allowed_project_id"
   FROM "public"."portal_project_ids"() "portal_project_ids"("allowed_project_id"))));



CREATE POLICY "Portal members can read device config state" ON "public"."device_config_state" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "portal_project_ids"."allowed_project_id"
   FROM "public"."portal_project_ids"() "portal_project_ids"("allowed_project_id"))));



CREATE POLICY "Portal members can read device runtime state" ON "public"."device_runtime_state" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "portal_project_ids"."allowed_project_id"
   FROM "public"."portal_project_ids"() "portal_project_ids"("allowed_project_id"))));



CREATE POLICY "Users can read software terms acceptances" ON "public"."software_terms_acceptances" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_portal_admin"("project_id")));



CREATE POLICY "Users can read their portal access" ON "public"."portal_access" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR ("project_id" IN ( SELECT "portal_admin_project_ids"."allowed_project_id"
   FROM "public"."portal_admin_project_ids"() "portal_admin_project_ids"("allowed_project_id")))));



CREATE POLICY "admins request calibration setting" ON "public"."calibration_set_requests" FOR INSERT TO "authenticated" WITH CHECK ((("requested_by" = ( SELECT "auth"."uid"() AS "uid")) AND ("project_id" IN ( SELECT "portal_admin_project_ids"."allowed_project_id"
   FROM "public"."portal_admin_project_ids"() "portal_admin_project_ids"("allowed_project_id")))));



ALTER TABLE "public"."assistant_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assistant_monitor_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assistant_monitors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assistant_schedule_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assistant_schedules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assistant_threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calibration_candidates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calibration_observations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calibration_set_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calibration_studies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_config_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_control_quarantines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_control_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_health_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_ingest_leases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_maintenance_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_runtime_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_secrets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."devices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."experiment_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."experiment_audit_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."experiment_builder_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."experiment_control_plan_steps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."experiment_control_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."experiment_revisions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."experiments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."latest_device_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "members read devices" ON "public"."devices" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "member_project_ids"."allowed_project_id"
   FROM "public"."member_project_ids"() "member_project_ids"("allowed_project_id"))));



CREATE POLICY "members read latest device state" ON "public"."latest_device_state" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "member_project_ids"."allowed_project_id"
   FROM "public"."member_project_ids"() "member_project_ids"("allowed_project_id"))));



CREATE POLICY "members read organizations" ON "public"."organizations" FOR SELECT TO "authenticated" USING (("id" IN ( SELECT "member_organization_ids"."allowed_organization_id"
   FROM "public"."member_organization_ids"() "member_organization_ids"("allowed_organization_id"))));



CREATE POLICY "members read own memberships" ON "public"."project_members" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "members read pairings" ON "public"."pairings" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "member_project_ids"."allowed_project_id"
   FROM "public"."member_project_ids"() "member_project_ids"("allowed_project_id"))));



CREATE POLICY "members read projects" ON "public"."projects" FOR SELECT TO "authenticated" USING (("id" IN ( SELECT "member_project_ids"."allowed_project_id"
   FROM "public"."member_project_ids"() "member_project_ids"("allowed_project_id"))));



CREATE POLICY "members read sensor readings" ON "public"."sensor_readings" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "member_project_ids"."allowed_project_id"
   FROM "public"."member_project_ids"() "member_project_ids"("allowed_project_id"))));



CREATE POLICY "members read sensors" ON "public"."sensors" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "member_project_ids"."allowed_project_id"
   FROM "public"."member_project_ids"() "member_project_ids"("allowed_project_id"))));



CREATE POLICY "observation owners delete calibration observations" ON "public"."calibration_observations" FOR DELETE TO "authenticated" USING ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR ("project_id" IN ( SELECT "portal_admin_project_ids"."allowed_project_id"
   FROM "public"."portal_admin_project_ids"() "portal_admin_project_ids"("allowed_project_id")))));



CREATE POLICY "observation owners manage calibration observations" ON "public"."calibration_observations" FOR UPDATE TO "authenticated" USING ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR ("project_id" IN ( SELECT "portal_admin_project_ids"."allowed_project_id"
   FROM "public"."portal_admin_project_ids"() "portal_admin_project_ids"("allowed_project_id"))))) WITH CHECK (("public"."has_portal_access"("project_id") AND (("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR ("project_id" IN ( SELECT "portal_admin_project_ids"."allowed_project_id"
   FROM "public"."portal_admin_project_ids"() "portal_admin_project_ids"("allowed_project_id"))))));



ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pairings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "portal members read experiment assignments" ON "public"."experiment_assignments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."experiments" "e"
  WHERE (("e"."id" = "experiment_assignments"."experiment_id") AND ("e"."project_id" = "experiment_assignments"."project_id")))));



CREATE POLICY "portal members read experiment audit events" ON "public"."experiment_audit_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."experiments" "e"
  WHERE (("e"."id" = "experiment_audit_events"."experiment_id") AND ("e"."project_id" = "experiment_audit_events"."project_id")))));



CREATE POLICY "portal members read experiment revisions" ON "public"."experiment_revisions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."experiments" "e"
  WHERE (("e"."id" = "experiment_revisions"."experiment_id") AND ("e"."project_id" = "experiment_revisions"."project_id")))));



CREATE POLICY "portal members read visible control plan steps" ON "public"."experiment_control_plan_steps" FOR SELECT TO "authenticated" USING (("public"."has_portal_access"("project_id") AND (EXISTS ( SELECT 1
   FROM ("public"."experiment_control_plans" "plan"
     JOIN "public"."experiments" "experiment" ON (("experiment"."id" = "plan"."experiment_id")))
  WHERE (("plan"."id" = "experiment_control_plan_steps"."plan_id") AND ("plan"."project_id" = "experiment_control_plan_steps"."project_id"))))));



CREATE POLICY "portal members read visible control plans" ON "public"."experiment_control_plans" FOR SELECT TO "authenticated" USING (("public"."has_portal_access"("project_id") AND (EXISTS ( SELECT 1
   FROM "public"."experiments" "experiment"
  WHERE (("experiment"."id" = "experiment_control_plans"."experiment_id") AND ("experiment"."project_id" = "experiment_control_plans"."project_id"))))));



CREATE POLICY "portal members read visible experiments" ON "public"."experiments" FOR SELECT TO "authenticated" USING (("public"."has_portal_access"("project_id") AND (("public"."current_portal_role"("project_id") = 'admin'::"text") OR ("public"."current_portal_role"("project_id") = ANY ("visible_to_roles")))));



ALTER TABLE "public"."portal_access" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project members create calibration candidates" ON "public"."calibration_candidates" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_portal_access"("project_id") AND ("created_by" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "project members create calibration observations" ON "public"."calibration_observations" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_portal_access"("project_id") AND ("created_by" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "project members create calibration studies" ON "public"."calibration_studies" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_portal_access"("project_id") AND ("created_by" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "project members read calibration candidates" ON "public"."calibration_candidates" FOR SELECT TO "authenticated" USING ("public"."has_portal_access"("project_id"));



CREATE POLICY "project members read calibration observations" ON "public"."calibration_observations" FOR SELECT TO "authenticated" USING ("public"."has_portal_access"("project_id"));



CREATE POLICY "project members read calibration set requests" ON "public"."calibration_set_requests" FOR SELECT TO "authenticated" USING ("public"."has_portal_access"("project_id"));



CREATE POLICY "project members read calibration studies" ON "public"."calibration_studies" FOR SELECT TO "authenticated" USING ("public"."has_portal_access"("project_id"));



ALTER TABLE "public"."project_control_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."project_control_commands" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."project_invites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."project_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."public_submission_rate_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."quote_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_access_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_correction_episodes_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_curve_outcomes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_curve_predictions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_episode_outcomes_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_episode_outcomes_v3" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_episode_scores_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_episode_scores_v3" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_evaluation_windows_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_event_attributions_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_event_exclusions_v4" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_event_finalizations_v5" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_feature_snapshots_v4" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_irrigation_episodes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_irrigation_events_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_model_promotions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_model_updates_v4" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_model_updates_v5" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_model_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_observer_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_pairing_adapters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_post_open_scores_v5" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_prediction_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_prediction_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_prequential_scores_v5" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_response_horizons_v4" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_response_scores_v4" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_shadow_model_channel_events_v5" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_shadow_model_channels_v5" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_system_admin_access" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rd_training_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sensor_readings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sensors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."software_terms_acceptances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "study owners manage calibration studies" ON "public"."calibration_studies" FOR UPDATE TO "authenticated" USING ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR ("project_id" IN ( SELECT "portal_admin_project_ids"."allowed_project_id"
   FROM "public"."portal_admin_project_ids"() "portal_admin_project_ids"("allowed_project_id"))))) WITH CHECK (("public"."has_portal_access"("project_id") AND (("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR ("project_id" IN ( SELECT "portal_admin_project_ids"."allowed_project_id"
   FROM "public"."portal_admin_project_ids"() "portal_admin_project_ids"("allowed_project_id"))))));



ALTER TABLE "public"."support_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."support_notes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."support_threads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users create own builder requests" ON "public"."experiment_builder_requests" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("public"."current_portal_role"("project_id") = ANY (ARRAY['admin'::"text", 'researcher'::"text"]))));



CREATE POLICY "users read own assistant messages" ON "public"."assistant_messages" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND "public"."has_portal_access"("project_id")));



CREATE POLICY "users read own assistant threads" ON "public"."assistant_threads" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND "public"."has_portal_access"("project_id")));



CREATE POLICY "users read own builder requests" ON "public"."experiment_builder_requests" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND "public"."has_portal_access"("project_id")));



CREATE POLICY "users read own monitor events" ON "public"."assistant_monitor_events" FOR SELECT TO "authenticated" USING (("public"."has_portal_access"("project_id") AND (EXISTS ( SELECT 1
   FROM "public"."assistant_monitors" "monitor"
  WHERE (("monitor"."id" = "assistant_monitor_events"."monitor_id") AND (("monitor"."created_by" = ( SELECT "auth"."uid"() AS "uid")) OR ("public"."current_portal_role"("monitor"."project_id") = 'admin'::"text")))))));



CREATE POLICY "users read own monitors" ON "public"."assistant_monitors" FOR SELECT TO "authenticated" USING (("public"."has_portal_access"("project_id") AND (("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR ("public"."current_portal_role"("project_id") = 'admin'::"text"))));



CREATE POLICY "users read own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "users read own schedule runs" ON "public"."assistant_schedule_runs" FOR SELECT TO "authenticated" USING (("public"."has_portal_access"("project_id") AND (EXISTS ( SELECT 1
   FROM "public"."assistant_schedules" "schedule"
  WHERE (("schedule"."id" = "assistant_schedule_runs"."schedule_id") AND (("schedule"."created_by" = ( SELECT "auth"."uid"() AS "uid")) OR ("public"."current_portal_role"("schedule"."project_id") = 'admin'::"text")))))));



CREATE POLICY "users read own schedules" ON "public"."assistant_schedules" FOR SELECT TO "authenticated" USING (("public"."has_portal_access"("project_id") AND (("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR ("public"."current_portal_role"("project_id") = 'admin'::"text"))));



ALTER TABLE "public"."valve_events" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."acquire_device_ingest_lease"("lease_project_id" "uuid", "lease_device_id" "text", "lease_holder" "uuid", "lease_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."acquire_device_ingest_lease"("lease_project_id" "uuid", "lease_device_id" "text", "lease_holder" "uuid", "lease_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."attach_experiment_control_plan"("requested_experiment_id" "uuid", "requested_actor_id" "uuid", "reviewed_spec" "jsonb", "compiled_plan" "jsonb", "expected_inventory_updated_at" timestamp with time zone, "expected_config_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attach_experiment_control_plan"("requested_experiment_id" "uuid", "requested_actor_id" "uuid", "reviewed_spec" "jsonb", "compiled_plan" "jsonb", "expected_inventory_updated_at" timestamp with time zone, "expected_config_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."check_public_submission"("submission_scope" "text", "submission_client_hash" "text", "max_requests" integer, "window_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_public_submission"("submission_scope" "text", "submission_client_hash" "text", "max_requests" integer, "window_seconds" integer) TO "service_role";



GRANT ALL ON TABLE "public"."assistant_schedules" TO "service_role";
GRANT SELECT ON TABLE "public"."assistant_schedules" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."claim_due_assistant_schedules"("claim_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_due_assistant_schedules"("claim_limit" integer) TO "service_role";



GRANT ALL ON TABLE "public"."rd_jobs" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_rd_jobs"("claim_worker" "text", "claim_limit" integer, "claim_lease_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_rd_jobs"("claim_worker" "text", "claim_limit" integer, "claim_lease_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_rd_jobs_v3"("claim_worker" "text", "claim_kind" "text", "claim_limit" integer, "claim_lease_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_rd_jobs_v3"("claim_worker" "text", "claim_kind" "text", "claim_limit" integer, "claim_lease_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_device_control_token"("token_project_id" "uuid", "token_device_id" "text", "token_label" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_device_control_token"("token_project_id" "uuid", "token_device_id" "text", "token_label" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_project_invite"("invitee_email" "text", "invited_project_id" "uuid", "invite_role" "text", "invite_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_project_invite"("invitee_email" "text", "invited_project_id" "uuid", "invite_role" "text", "invite_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_portal_role"("check_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_portal_role"("check_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_portal_role"("check_project_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."device_claim_control_command"("device_token" "text", "executor_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."device_claim_control_command"("device_token" "text", "executor_version" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."device_claim_control_command"("device_token" "text", "executor_version" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."device_complete_control_command"("device_token" "text", "command_id" "uuid", "final_status" "text", "command_result" "jsonb", "command_error" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."device_complete_control_command"("device_token" "text", "command_id" "uuid", "final_status" "text", "command_result" "jsonb", "command_error" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."device_complete_control_command"("device_token" "text", "command_id" "uuid", "final_status" "text", "command_result" "jsonb", "command_error" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."device_ingest"("device_token" "text", "payload" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."device_ingest"("device_token" "text", "payload" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."device_ingest"("device_token" "text", "payload" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."device_quarantine_control_command"("device_token" "text", "command_id" "uuid", "quarantine_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."device_quarantine_control_command"("device_token" "text", "command_id" "uuid", "quarantine_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."device_quarantine_control_command"("device_token" "text", "command_id" "uuid", "quarantine_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."device_renew_control_command_lease"("device_token" "text", "command_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."device_renew_control_command_lease"("device_token" "text", "command_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."device_renew_control_command_lease"("device_token" "text", "command_id" "uuid") TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."project_control_commands" TO "service_role";
GRANT SELECT ON TABLE "public"."project_control_commands" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."enqueue_portal_control_command"("command_project_id" "uuid", "command_device_id" "text", "command_type" "text", "command_payload" "jsonb", "command_requested_by" "uuid", "command_expires_at" timestamp with time zone, "command_requires_confirmation" boolean, "command_confirmed_at" timestamp with time zone, "command_client_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_portal_control_command"("command_project_id" "uuid", "command_device_id" "text", "command_type" "text", "command_payload" "jsonb", "command_requested_by" "uuid", "command_expires_at" timestamp with time zone, "command_requires_confirmation" boolean, "command_confirmed_at" timestamp with time zone, "command_client_request_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."enqueue_portal_control_command_batch"("command_project_id" "uuid", "command_device_id" "text", "command_requested_by" "uuid", "command_batch_id" "uuid", "command_expires_at" timestamp with time zone, "expected_config_hash" "text", "expected_controller_state" "text", "batch_commands" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_portal_control_command_batch"("command_project_id" "uuid", "command_device_id" "text", "command_requested_by" "uuid", "command_batch_id" "uuid", "command_expires_at" timestamp with time zone, "expected_config_hash" "text", "expected_controller_state" "text", "batch_commands" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."enqueue_portal_control_command_v2"("command_project_id" "uuid", "command_device_id" "text", "command_type" "text", "command_payload" "jsonb", "command_requested_by" "uuid", "command_expires_at" timestamp with time zone, "command_requires_confirmation" boolean, "command_confirmed_at" timestamp with time zone, "command_client_request_id" "uuid", "command_depends_on_id" "uuid", "command_batch_id" "uuid", "command_experiment_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_portal_control_command_v2"("command_project_id" "uuid", "command_device_id" "text", "command_type" "text", "command_payload" "jsonb", "command_requested_by" "uuid", "command_expires_at" timestamp with time zone, "command_requires_confirmation" boolean, "command_confirmed_at" timestamp with time zone, "command_client_request_id" "uuid", "command_depends_on_id" "uuid", "command_batch_id" "uuid", "command_experiment_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."finish_assistant_schedule_run"("requested_schedule_id" "uuid", "run_status" "text", "run_batch_id" "uuid", "run_details" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finish_assistant_schedule_run"("requested_schedule_id" "uuid", "run_status" "text", "run_batch_id" "uuid", "run_details" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_portal_access"("check_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_portal_access"("check_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_portal_access"("check_project_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_rd_system_admin_access"("check_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_rd_system_admin_access"("check_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_rd_system_admin_access"("check_project_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."invoke_assistant_automation_runner"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."invoke_assistant_automation_runner"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."invoke_owner_health_sync"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."invoke_owner_health_sync"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_portal_admin"("check_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_portal_admin"("check_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_portal_admin"("check_project_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."mark_experiment_activation_enqueue_failed"("requested_plan_id" "uuid", "failure_message" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_experiment_activation_enqueue_failed"("requested_plan_id" "uuid", "failure_message" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."member_organization_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."member_organization_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."member_organization_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."member_project_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."member_project_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."member_project_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."mirror_live_sensor_readings"("reading_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mirror_live_sensor_readings"("reading_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."portal_admin_project_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."portal_admin_project_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."portal_admin_project_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."portal_project_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."portal_project_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."portal_project_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."portal_role_for_invite"("invite_role" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."project_member_role_for_invite"("invite_role" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."promote_rd_model"("promote_project_id" "uuid", "promote_model_version_id" "uuid", "promotion_evidence" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promote_rd_model"("promote_project_id" "uuid", "promote_model_version_id" "uuid", "promotion_evidence" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."prune_device_health_history"("retention_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_device_health_history"("retention_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."publish_sensing_experiment"("requested_project_id" "uuid", "reviewed_spec" "jsonb", "expected_inventory_updated_at" timestamp with time zone, "draft_source" "text", "draft_model_name" "text", "draft_prompt_fingerprint" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."publish_sensing_experiment"("requested_project_id" "uuid", "reviewed_spec" "jsonb", "expected_inventory_updated_at" timestamp with time zone, "draft_source" "text", "draft_model_name" "text", "draft_prompt_fingerprint" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."rd_atomic_event_observation_v4"("observation_irrigation_event_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_atomic_event_observation_v4"("observation_irrigation_event_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_block_immutable_mutation"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."rd_enforce_committed_prediction_causality"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."rd_episode_observation_v3"("observation_episode_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_episode_observation_v3"("observation_episode_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_guard_model_status_change"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."rd_promote_model_v2"("promote_project_id" "uuid", "promote_model_version_id" "uuid", "promote_evidence" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_promote_model_v2"("promote_project_id" "uuid", "promote_model_version_id" "uuid", "promote_evidence" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_promote_v5_shadow_candidate"("promote_project_id" "uuid", "promote_device_id" "text", "promote_model_version_id" "uuid", "promote_evidence" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_promote_v5_shadow_candidate"("promote_project_id" "uuid", "promote_device_id" "text", "promote_model_version_id" "uuid", "promote_evidence" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_publish_provisional_model_v4"("publish_version" "text", "publish_artifact_path" "text", "publish_artifact_sha256" "text", "publish_evidence_fingerprint" "text", "publish_training_event_count" integer, "publish_training_horizon_count" integer, "publish_metrics" "jsonb", "publish_parameters" "jsonb", "publish_code_commit" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_publish_provisional_model_v4"("publish_version" "text", "publish_artifact_path" "text", "publish_artifact_sha256" "text", "publish_evidence_fingerprint" "text", "publish_training_event_count" integer, "publish_training_horizon_count" integer, "publish_metrics" "jsonb", "publish_parameters" "jsonb", "publish_code_commit" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_publish_v5_challenger"("publish_version" "text", "publish_artifact_path" "text", "publish_artifact_sha256" "text", "publish_evidence_fingerprint" "text", "publish_training_event_count" integer, "publish_training_horizon_count" integer, "publish_metrics" "jsonb", "publish_parameters" "jsonb", "publish_dataset_manifest" "jsonb", "publish_code_commit" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_publish_v5_challenger"("publish_version" "text", "publish_artifact_path" "text", "publish_artifact_sha256" "text", "publish_evidence_fingerprint" "text", "publish_training_event_count" integer, "publish_training_horizon_count" integer, "publish_metrics" "jsonb", "publish_parameters" "jsonb", "publish_dataset_manifest" "jsonb", "publish_code_commit" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_record_irrigation_event_v2"("record_project_id" "uuid", "record_device_id" "text", "record_pairing_name" "text", "record_valve_event_id" "text", "record_opened_device_at" timestamp with time zone, "record_duration_ms" integer, "record_duration_source" "text", "record_source_class" "text", "record_evidence_source" "text", "record_prediction_id" "uuid", "record_prediction_lead_seconds" integer, "record_target_vwc" double precision, "record_config_hash" "text", "record_quality" "jsonb", "record_settle_gap_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_record_irrigation_event_v2"("record_project_id" "uuid", "record_device_id" "text", "record_pairing_name" "text", "record_valve_event_id" "text", "record_opened_device_at" timestamp with time zone, "record_duration_ms" integer, "record_duration_source" "text", "record_source_class" "text", "record_evidence_source" "text", "record_prediction_id" "uuid", "record_prediction_lead_seconds" integer, "record_target_vwc" double precision, "record_config_hash" "text", "record_quality" "jsonb", "record_settle_gap_minutes" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_refresh_episode_states_v2"("reference_at" timestamp with time zone, "settle_gap_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_refresh_episode_states_v2"("reference_at" timestamp with time zone, "settle_gap_minutes" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_reject_and_advance_v5_shadow_candidate"("reject_project_id" "uuid", "reject_device_id" "text", "reject_model_version_id" "uuid", "reject_expected_evaluation_started_at" timestamp with time zone, "reject_evidence" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_reject_and_advance_v5_shadow_candidate"("reject_project_id" "uuid", "reject_device_id" "text", "reject_model_version_id" "uuid", "reject_expected_evaluation_started_at" timestamp with time zone, "reject_evidence" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_training_evidence_page_v4"("evidence_kind" "text", "cursor_device_at" timestamp with time zone, "cursor_event_id" "text", "page_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_training_evidence_page_v4"("evidence_kind" "text", "cursor_device_at" timestamp with time zone, "cursor_event_id" "text", "page_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_worker_observation"("observation_project_id" "uuid", "observation_device_id" "text", "observation_since" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_worker_observation"("observation_project_id" "uuid", "observation_device_id" "text", "observation_since" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."rd_worker_predictions_v3"("observation_project_id" "uuid", "recent_since" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rd_worker_predictions_v3"("observation_project_id" "uuid", "recent_since" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_device_control_quarantine"("reconcile_project_id" "uuid", "reconcile_device_id" "text", "observed_at" timestamp with time zone, "confirmed_valves_closed" boolean, "observed_state" "jsonb", "reconciliation_note" "text", "reenable_commands" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_device_control_quarantine"("reconcile_project_id" "uuid", "reconcile_device_id" "text", "observed_at" timestamp with time zone, "confirmed_valves_closed" boolean, "observed_state" "jsonb", "reconciliation_note" "text", "reenable_commands" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_experiment_control_plan"("requested_plan_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_experiment_control_plan"("requested_plan_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_device_ingest_lease"("lease_project_id" "uuid", "lease_device_id" "text", "lease_holder" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_device_ingest_lease"("lease_project_id" "uuid", "lease_device_id" "text", "lease_holder" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."restore_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."restore_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."restore_assistant_experiment"("requested_project_id" "uuid", "requested_experiment_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."run_device_health_retention"("retention_days" integer, "minimum_interval_hours" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."run_device_health_retention"("retention_days" integer, "minimum_interval_hours" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."save_public_quote_submission"("submission_data" "jsonb", "submission_fingerprint_value" "text", "notification_recipient" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_public_quote_submission"("submission_data" "jsonb", "submission_fingerprint_value" "text", "notification_recipient" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."save_public_support_submission"("submission_data" "jsonb", "submission_fingerprint_value" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_public_support_submission"("submission_data" "jsonb", "submission_fingerprint_value" "text") TO "service_role";



GRANT ALL ON TABLE "public"."assistant_messages" TO "service_role";
GRANT SELECT ON TABLE "public"."assistant_messages" TO "authenticated";



GRANT ALL ON TABLE "public"."assistant_monitor_events" TO "service_role";
GRANT SELECT ON TABLE "public"."assistant_monitor_events" TO "authenticated";



GRANT ALL ON TABLE "public"."assistant_monitors" TO "service_role";
GRANT SELECT ON TABLE "public"."assistant_monitors" TO "authenticated";



GRANT ALL ON TABLE "public"."assistant_schedule_runs" TO "service_role";
GRANT SELECT ON TABLE "public"."assistant_schedule_runs" TO "authenticated";



GRANT ALL ON TABLE "public"."assistant_threads" TO "service_role";
GRANT SELECT ON TABLE "public"."assistant_threads" TO "authenticated";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calibration_candidates" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calibration_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."calibration_observations" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calibration_observations" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calibration_set_requests" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calibration_set_requests" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."calibration_studies" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."calibration_studies" TO "service_role";



GRANT ALL ON TABLE "public"."device_config_state" TO "service_role";
GRANT SELECT ON TABLE "public"."device_config_state" TO "authenticated";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."device_control_quarantines" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."device_control_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."device_health_snapshots" TO "service_role";
GRANT SELECT ON TABLE "public"."device_health_snapshots" TO "authenticated";



GRANT ALL ON TABLE "public"."device_ingest_leases" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."device_maintenance_state" TO "service_role";



GRANT ALL ON TABLE "public"."device_runtime_state" TO "service_role";
GRANT SELECT ON TABLE "public"."device_runtime_state" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."device_secrets" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."device_secrets" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."device_secrets" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."devices" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."devices" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."devices" TO "service_role";



GRANT ALL ON TABLE "public"."experiment_assignments" TO "service_role";
GRANT SELECT ON TABLE "public"."experiment_assignments" TO "authenticated";



GRANT ALL ON TABLE "public"."experiment_audit_events" TO "service_role";
GRANT SELECT ON TABLE "public"."experiment_audit_events" TO "authenticated";



GRANT ALL ON TABLE "public"."experiment_builder_requests" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."experiment_builder_requests" TO "authenticated";



GRANT ALL ON TABLE "public"."experiment_control_plan_steps" TO "service_role";
GRANT SELECT ON TABLE "public"."experiment_control_plan_steps" TO "authenticated";



GRANT ALL ON TABLE "public"."experiment_control_plans" TO "service_role";
GRANT SELECT ON TABLE "public"."experiment_control_plans" TO "authenticated";



GRANT ALL ON TABLE "public"."experiment_revisions" TO "service_role";
GRANT SELECT ON TABLE "public"."experiment_revisions" TO "authenticated";



GRANT ALL ON TABLE "public"."experiments" TO "service_role";
GRANT SELECT ON TABLE "public"."experiments" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."latest_device_state" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."latest_device_state" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."latest_device_state" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."organizations" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."organizations" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."organizations" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pairings" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pairings" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pairings" TO "service_role";



GRANT ALL ON TABLE "public"."portal_access" TO "service_role";
GRANT SELECT ON TABLE "public"."portal_access" TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."portal_experiment_catalog" TO "authenticated";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."portal_experiment_catalog" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."profiles" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."project_control_audit" TO "service_role";
GRANT SELECT ON TABLE "public"."project_control_audit" TO "authenticated";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."project_invites" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."project_members" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."project_members" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."project_members" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."projects" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."projects" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."public_submission_rate_limits" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."quote_requests" TO "service_role";
GRANT SELECT,UPDATE ON TABLE "public"."quote_requests" TO "authenticated";



GRANT ALL ON TABLE "public"."rd_access_audit" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."rd_access_audit_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."rd_correction_episodes_v2" TO "service_role";



GRANT ALL ON TABLE "public"."rd_curve_outcomes" TO "service_role";



GRANT ALL ON TABLE "public"."rd_curve_predictions" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_episode_outcomes_v2" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_episode_outcomes_v3" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_episode_scores_v2" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_episode_scores_v3" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_evaluation_windows_v2" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_event_attributions_v2" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_event_exclusions_v4" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_event_finalizations_v5" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_feature_snapshots_v4" TO "service_role";



GRANT ALL ON TABLE "public"."rd_irrigation_episodes" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_irrigation_events_v2" TO "service_role";



GRANT ALL ON TABLE "public"."rd_model_promotions" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_model_updates_v4" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_model_updates_v5" TO "service_role";



GRANT ALL ON TABLE "public"."rd_model_versions" TO "service_role";



GRANT ALL ON TABLE "public"."rd_observer_state" TO "service_role";



GRANT ALL ON TABLE "public"."rd_pairing_adapters" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_post_open_scores_v5" TO "service_role";



GRANT ALL ON TABLE "public"."rd_prediction_events" TO "service_role";



GRANT ALL ON TABLE "public"."rd_prediction_scores" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_prequential_scores_v5" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_response_horizons_v4" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_response_scores_v4" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."rd_shadow_model_channel_events_v5" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."rd_shadow_model_channels_v5" TO "service_role";



GRANT ALL ON TABLE "public"."rd_system_admin_access" TO "service_role";



GRANT ALL ON TABLE "public"."rd_training_runs" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sensor_readings" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sensor_readings" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sensor_readings" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sensors" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sensors" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sensors" TO "service_role";



GRANT ALL ON TABLE "public"."software_terms_acceptances" TO "service_role";
GRANT SELECT ON TABLE "public"."software_terms_acceptances" TO "authenticated";



GRANT ALL ON TABLE "public"."support_messages" TO "service_role";
GRANT SELECT ON TABLE "public"."support_messages" TO "authenticated";



GRANT ALL ON TABLE "public"."support_notes" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."support_notes" TO "authenticated";



GRANT ALL ON TABLE "public"."support_threads" TO "service_role";
GRANT SELECT,UPDATE ON TABLE "public"."support_threads" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."valve_events" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."valve_events" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."valve_events" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."valve_events_id_seq" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";

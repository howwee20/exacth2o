#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
baseline_version="20260724210000"
baseline_file="$repo_root/supabase/baseline/${baseline_version}_public_schema.sql"
checksum_file="${baseline_file}.sha256"
restore_root="$(mktemp -d "${TMPDIR:-/tmp}/exacth2o-baseline-restore.XXXXXX")"
restore_workdir="$restore_root/supabase"
started=false

cleanup() {
  if [[ "$started" == true ]]; then
    supabase stop --workdir "$restore_root" --no-backup >/dev/null 2>&1 || true
  fi
  rm -rf "$restore_root"
}
trap cleanup EXIT

if command -v shasum >/dev/null 2>&1; then
  expected="$(awk '{print $1}' "$checksum_file")"
  actual="$(shasum -a 256 "$baseline_file" | awk '{print $1}')"
else
  expected="$(awk '{print $1}' "$checksum_file")"
  actual="$(sha256sum "$baseline_file" | awk '{print $1}')"
fi

if [[ "$actual" != "$expected" ]]; then
  echo "Database baseline checksum mismatch." >&2
  exit 1
fi

mkdir -p "$restore_workdir/migrations"
cp "$repo_root/supabase/config.toml" "$restore_workdir/config.toml"
cp "$baseline_file" \
  "$restore_workdir/migrations/${baseline_version}_public_schema.sql"

while IFS= read -r migration; do
  cp "$migration" "$restore_workdir/migrations/"
done < <(
  find "$repo_root/supabase/migrations" -maxdepth 1 -type f -name '*.sql' \
    | sort \
    | awk -v cutoff="$baseline_version" '
        {
          filename = $0
          sub(/^.*\//, "", filename)
          version = filename
          sub(/_.*/, "", version)
          if (version > cutoff) print $0
        }
      '
)

sed -i.bak \
  's/project_id = ".*"/project_id = "exacth2o-baseline-restore"/' \
  "$restore_workdir/config.toml"
rm -f "$restore_workdir/config.toml.bak"

supabase start \
  --workdir "$restore_root" \
  -x studio,imgproxy,edge-runtime,logflare,vector,supavisor \
  >/dev/null
started=true

psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
  -v ON_ERROR_STOP=1 \
  -Atc "
    do \$\$
    declare
      platform_view_count integer;
      rls_table_count integer;
      foundation_policy_count integer;
      walker_rls_table_count integer;
      walker_control_trigger_count integer;
      walker_blocked boolean;
      walker_test_user constant uuid :=
        '44444444-4444-4444-8444-444444444444'::uuid;
      walker_snapshot jsonb;
      walker_result jsonb;
      walker_live_blocked boolean;
    begin
      if to_regclass('public.platform_operations') is null
         or to_regclass('public.delivery_evidence') is null
         or to_regclass('public.notification_outbox') is null
         or to_regclass('public.research_pots') is null then
        raise exception 'Restored database is missing platform foundation tables';
      end if;

      select count(*)
      into platform_view_count
      from information_schema.views
      where table_schema = 'public'
        and table_name in (
          'portal_operation_timeline',
          'portal_identity_reconciliation',
          'portal_experiment_catalog'
        );

      if platform_view_count <> 3 then
        raise exception 'Restored database is missing platform views';
      end if;

      if not exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'portal_experiment_catalog'
          and column_name = 'current_spec'
      ) then
        raise exception 'Experiment catalog is missing the editable current specification';
      end if;

      if to_regprocedure(
        'public.revise_and_attach_experiment(uuid,uuid,uuid,jsonb,jsonb,timestamptz,text,text,text,text)'
      ) is null then
        raise exception 'Experiment revision RPC is missing';
      end if;

      if has_function_privilege(
        'anon',
        'public.revise_and_attach_experiment(uuid,uuid,uuid,jsonb,jsonb,timestamptz,text,text,text,text)',
        'EXECUTE'
      ) or has_function_privilege(
        'authenticated',
        'public.revise_and_attach_experiment(uuid,uuid,uuid,jsonb,jsonb,timestamptz,text,text,text,text)',
        'EXECUTE'
      ) or not has_function_privilege(
        'service_role',
        'public.revise_and_attach_experiment(uuid,uuid,uuid,jsonb,jsonb,timestamptz,text,text,text,text)',
        'EXECUTE'
      ) then
        raise exception 'Experiment revision RPC privileges are unsafe';
      end if;

      if to_regclass('public.device_control_executor_status') is null
         or not (
           select relation.relrowsecurity
           from pg_class relation
           join pg_namespace namespace on namespace.oid = relation.relnamespace
           where namespace.nspname = 'public'
             and relation.relname = 'device_control_executor_status'
         ) then
        raise exception 'Controller executor readiness table or RLS is missing';
      end if;

      if to_regprocedure(
        'public.device_report_control_executor_status(text,text,boolean,boolean,boolean,boolean,text,text)'
      ) is null
         or not has_function_privilege(
           'anon',
           'public.device_report_control_executor_status(text,text,boolean,boolean,boolean,boolean,text,text)',
           'EXECUTE'
         )
         or not has_function_privilege(
           'authenticated',
           'public.device_report_control_executor_status(text,text,boolean,boolean,boolean,boolean,text,text)',
           'EXECUTE'
         )
         or has_table_privilege(
           'authenticated',
           'public.device_control_executor_status',
           'SELECT'
         )
         or not has_table_privilege(
           'service_role',
           'public.device_control_executor_status',
           'SELECT'
         ) then
        raise exception 'Controller executor readiness privileges are unsafe';
      end if;

      insert into public.device_control_tokens (
        project_id,
        device_id,
        label,
        token_hash,
        enabled
      ) values (
        '22222222-2222-4222-8222-222222222222'::uuid,
        'baseline-controller-readiness-test',
        'baseline readiness verification',
        encode(extensions.digest('baseline-readiness-token', 'sha256'), 'hex'),
        true
      )
      on conflict (token_hash) do update
      set enabled = true,
          revoked_at = null;

      perform public.device_report_control_executor_status(
        'baseline-readiness-token',
        'baseline-verifier/1.0',
        false,
        false,
        true,
        true,
        'STOPPED',
        null
      );

      if not exists (
        select 1
        from public.device_control_executor_status status
        where status.project_id = '22222222-2222-4222-8222-222222222222'::uuid
          and status.device_id = 'baseline-controller-readiness-test'
          and status.executor_version = 'baseline-verifier/1.0'
          and status.dry_run = false
          and status.sync_ready = true
          and status.local_api_reachable = true
          and status.controller_state = 'STOPPED'
      ) then
        raise exception 'Controller executor readiness heartbeat is incorrect';
      end if;

      delete from public.device_control_executor_status
      where project_id = '22222222-2222-4222-8222-222222222222'::uuid
        and device_id = 'baseline-controller-readiness-test';
      delete from public.device_control_tokens
      where project_id = '22222222-2222-4222-8222-222222222222'::uuid
        and device_id = 'baseline-controller-readiness-test';

      select count(*)
      into rls_table_count
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname in (
          'project_platform_config',
          'research_sites',
          'physical_positions',
          'research_pots',
          'hardware_bindings',
          'platform_operations',
          'platform_operation_links',
          'platform_operation_events',
          'delivery_evidence',
          'notification_preferences',
          'notification_outbox',
          'notification_delivery_attempts'
        )
        and relation.relrowsecurity;

      if rls_table_count <> 12 then
        raise exception 'Restored database is missing foundation RLS';
      end if;

      select count(*)
      into foundation_policy_count
      from pg_policies
      where schemaname = 'public'
        and tablename in (
          'project_platform_config',
          'research_sites',
          'physical_positions',
          'research_pots',
          'hardware_bindings',
          'platform_operations',
          'platform_operation_links',
          'platform_operation_events',
          'delivery_evidence',
          'notification_preferences',
          'notification_outbox',
          'notification_delivery_attempts'
        );

      if foundation_policy_count < 12 then
        raise exception 'Restored database is missing foundation access policies';
      end if;

      if not has_function_privilege(
        'authenticated',
        'public.set_notification_preference(uuid,text,boolean,text,text[])',
        'EXECUTE'
      ) then
        raise exception 'Authenticated notification preference access is missing';
      end if;

      if to_regclass('public.walker_observation_workspaces') is null
         or to_regclass('public.walker_observation_imports') is null
         or to_regclass('public.walker_observation_sensor_metadata') is null
         or to_regclass('public.walker_observation_trace_buckets') is null
         or to_regclass('public.walker_live_telemetry_readings') is null
         or to_regclass('public.walker_live_ingest_state') is null then
        raise exception 'Restored database is missing Walker observation tables';
      end if;

      select count(*)
      into walker_rls_table_count
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname in (
          'system_admin_installation_access',
          'walker_observation_workspaces',
          'walker_observation_imports',
          'walker_observation_sensor_metadata',
          'walker_observation_trace_buckets',
          'walker_live_telemetry_readings',
          'walker_live_ingest_state'
        )
        and relation.relrowsecurity;

      if walker_rls_table_count <> 7 then
        raise exception 'Restored database is missing Walker RLS';
      end if;

      if has_function_privilege(
        'anon',
        'public.walker_observation_overview(uuid,text)',
        'EXECUTE'
      ) or not has_function_privilege(
        'authenticated',
        'public.walker_observation_overview(uuid,text)',
        'EXECUTE'
      ) or has_function_privilege(
        'authenticated',
        'public.walker_observation_finalize_import()',
        'EXECUTE'
      ) or has_function_privilege(
        'authenticated',
        'public.walker_observation_finalize_sensor(integer)',
        'EXECUTE'
      ) or has_function_privilege(
        'anon',
        'public.walker_live_observation_status(uuid,text)',
        'EXECUTE'
      ) or not has_function_privilege(
        'authenticated',
        'public.walker_live_observation_status(uuid,text)',
        'EXECUTE'
      ) or has_function_privilege(
        'authenticated',
        'public.walker_live_initialize_ingest(bigint,bigint,timestamptz,text)',
        'EXECUTE'
      ) or has_function_privilege(
        'authenticated',
        'public.ingest_walker_live_telemetry_batch(jsonb,bigint,bigint,timestamptz,text)',
        'EXECUTE'
      ) or has_function_privilege(
        'authenticated',
        'public.walker_live_record_heartbeat(bigint,bigint,timestamptz,text)',
        'EXECUTE'
      ) or not has_function_privilege(
        'service_role',
        'public.ingest_walker_live_telemetry_batch(jsonb,bigint,bigint,timestamptz,text)',
        'EXECUTE'
      ) then
        raise exception 'Walker observation function privileges are unsafe';
      end if;

      if has_table_privilege(
        'authenticated',
        'public.walker_live_telemetry_readings',
        'SELECT'
      ) or has_table_privilege(
        'service_role',
        'public.walker_live_telemetry_readings',
        'INSERT'
      ) then
        raise exception 'Walker live tables must be accessible only through bounded RPCs';
      end if;

      select count(*)
      into walker_control_trigger_count
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and trigger.tgname = 'block_walker_control_path'
        and not trigger.tgisinternal;

      if walker_control_trigger_count <> 5 then
        raise exception 'Walker control-path trigger coverage is incomplete';
      end if;

      if exists (
        select 1 from public.device_control_tokens
        where project_id = '33333333-3333-4333-8333-333333333331'::uuid
           or device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
      ) or exists (
        select 1 from public.project_control_commands
        where project_id = '33333333-3333-4333-8333-333333333331'::uuid
           or device_id = 'balena:a1c4ace2b367fbee8521f1aff6a6329b'
      ) then
        raise exception 'Walker baseline unexpectedly contains a control identity';
      end if;

      walker_blocked := false;
      begin
        insert into public.device_control_tokens (
          project_id, device_id, token_hash
        ) values (
          '33333333-3333-4333-8333-333333333331'::uuid,
          'balena:a1c4ace2b367fbee8521f1aff6a6329b',
          repeat('0', 64)
        );
      exception when raise_exception then
        walker_blocked :=
          sqlerrm like 'Walker Gate A is observation-only%';
      end;
      if not walker_blocked then
        raise exception 'Walker control-token registration was not blocked';
      end if;

      walker_blocked := false;
      begin
        insert into public.project_members (
          project_id, user_id, role
        ) values (
          '33333333-3333-4333-8333-333333333331'::uuid,
          gen_random_uuid(),
          'viewer'
        );
      exception when raise_exception then
        walker_blocked :=
          sqlerrm like 'Walker observation access requires%';
      end;
      if not walker_blocked then
        raise exception 'Walker generic project membership was not blocked';
      end if;

      insert into auth.users (
        instance_id,
        id,
        aud,
        role,
        email,
        encrypted_password,
        email_confirmed_at,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
      ) values (
        '00000000-0000-0000-0000-000000000000'::uuid,
        walker_test_user,
        'authenticated',
        'authenticated',
        'walker-read-model-test@example.invalid',
        '',
        now(),
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
      );

      insert into public.organizations (id, slug, name)
      values (
        '44444444-4444-4444-8444-444444444430'::uuid,
        'walker-read-model-test',
        'Walker Read Model Test'
      );

      insert into public.projects (id, organization_id, slug, name)
      values (
        '44444444-4444-4444-8444-444444444431'::uuid,
        '44444444-4444-4444-8444-444444444430'::uuid,
        'walker-read-model-test',
        'Walker Read Model Test'
      );

      insert into public.portal_access (
        project_id,
        user_id,
        email,
        role
      ) values (
        '44444444-4444-4444-8444-444444444431'::uuid,
        walker_test_user,
        'walker-read-model-test@example.invalid',
        'admin'
      );

      insert into public.system_admin_installation_access (
        project_id,
        device_id,
        portal_project_id,
        user_id,
        capability
      ) values (
        '33333333-3333-4333-8333-333333333331'::uuid,
        'balena:a1c4ace2b367fbee8521f1aff6a6329b',
        '44444444-4444-4444-8444-444444444431'::uuid,
        walker_test_user,
        'observe'
      );

      insert into public.walker_observation_sensor_metadata (
        project_id,
        device_id,
        source_sensor_id,
        sensor_key,
        display_label,
        source_pairing_name,
        position_number,
        board_serial_id,
        sensor_address
      )
      select
        '33333333-3333-4333-8333-333333333331'::uuid,
        'balena:a1c4ace2b367fbee8521f1aff6a6329b',
        700 + position,
        'SIM:' || position,
        case when position = 41 then 'Q-41' else position::text end,
        case when position = 41 then 'Q-41' else position::text end,
        position,
        case when position <= 52 then 'SIM-BOARD-A' else 'SIM-BOARD-B' end,
        position::text
      from generate_series(1, 100) position
      where position not in (48, 50, 51, 100);

      insert into public.sensor_readings (
        event_id,
        organization_id,
        project_id,
        device_id,
        source_sensor_id,
        sensor_key,
        pairing_name,
        device_recorded_at,
        server_received_at,
        raw_value,
        calibrated_value,
        unit,
        quality_flags
      )
      select
        'walker:test:historical-row',
        project.organization_id,
        project.id,
        'balena:a1c4ace2b367fbee8521f1aff6a6329b',
        701,
        'SIM:1',
        '1',
        now(),
        now(),
        1999,
        99,
        'vwc_pct',
        jsonb_build_object('historical', true)
      from public.projects project
      where project.id = '33333333-3333-4333-8333-333333333331'::uuid;

      perform set_config('request.jwt.claim.role', 'service_role', true);
      select public.walker_live_initialize_ingest(
        100,
        100,
        now() - interval '1 minute',
        'walker-pi5-a1c4ace2'
      ) into walker_result;
      if walker_result ->> 'initialized' <> 'true' then
        raise exception 'Walker live ingest did not initialize';
      end if;

      select public.ingest_walker_live_telemetry_batch(
        jsonb_build_array(jsonb_build_object(
          'source_reading_id', 101,
          'source_sensor_id', 701,
          'raw_value', 1200,
          'calibrated_value', 25,
          'temperature', 22,
          'electrical_conductivity', null,
          'device_recorded_at', now(),
          'source_created_at', now()
        )),
        101,
        101,
        now(),
        'walker-pi5-a1c4ace2'
      ) into walker_result;
      if walker_result ->> 'accepted' <> '1' then
        raise exception 'Walker live append did not accept the simulated reading';
      end if;

      select public.ingest_walker_live_telemetry_batch(
        jsonb_build_array(jsonb_build_object(
          'source_reading_id', 101,
          'source_sensor_id', 701,
          'raw_value', 1200,
          'calibrated_value', 25,
          'temperature', 22,
          'electrical_conductivity', null,
          'device_recorded_at', (
            select device_recorded_at
            from public.walker_live_telemetry_readings
            where source_reading_id = 101
          ),
          'source_created_at', (
            select source_created_at
            from public.walker_live_telemetry_readings
            where source_reading_id = 101
          )
        )),
        101,
        101,
        now(),
        'walker-pi5-a1c4ace2'
      ) into walker_result;
      if walker_result ->> 'replayed' <> '1' then
        raise exception 'Walker live append is not idempotent';
      end if;

      walker_live_blocked := false;
      begin
        update public.walker_live_telemetry_readings
        set calibrated_value = 30
        where source_reading_id = 101;
      exception when raise_exception then
        walker_live_blocked := sqlerrm = 'Walker live telemetry is append-only';
      end;
      if not walker_live_blocked then
        raise exception 'Walker live telemetry update was not blocked';
      end if;

      perform set_config(
        'request.jwt.claim.sub',
        walker_test_user::text,
        true
      );
      perform set_config('request.jwt.claim.role', 'authenticated', true);
      select public.walker_live_observation_snapshot(
        '33333333-3333-4333-8333-333333333331'::uuid,
        'balena:a1c4ace2b367fbee8521f1aff6a6329b',
        72,
        288
      ) into walker_snapshot;

      if jsonb_array_length(walker_snapshot -> 'sensors') <> 96
         or jsonb_array_length(walker_snapshot -> 'series') <> 96
         or walker_snapshot ->> 'evidenced_sensor_count' <> '96'
         or walker_snapshot ->> 'portal_control_available' <> 'false'
         or (
           select point ->> 'average'
           from jsonb_array_elements(walker_snapshot -> 'series') series,
                jsonb_array_elements(series -> 'points') point
           where series ->> 'source_sensor_id' = '701'
           limit 1
         ) <> '25' then
        raise exception 'Walker rolling snapshot is incorrect or archive-contaminated';
      end if;
    end
    \$\$;
  " >/dev/null

echo "ExactH2O database baseline restored and verified."

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
    end
    \$\$;
  " >/dev/null

echo "ExactH2O database baseline restored and verified."

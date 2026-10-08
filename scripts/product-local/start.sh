#!/usr/bin/env bash
# Disposable local environment for the coherent portal: the production schema baseline, every
# later migration (including this branch's), a synthetic seed and four test accounts.
#
#   scripts/product-local/start.sh            # start (or restart) and seed
#   scripts/product-local/start.sh --scenario board-outage|controller-offline|discrepancy|normal
#   scripts/product-local/stop.sh
#
# It runs on its own ports (API 55421, DB 55422) and project id, so it never touches another
# local Supabase stack. Nothing here talks to a hosted project. Test-account passwords are
# generated per run and written outside the repository (see the summary at the end).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_root="${EXACTH2O_PRODUCT_LOCAL_DIR:-${TMPDIR:-/tmp}/exacth2o-product-local}"
baseline_version="20260724210000"
api_port=55421
db_port=55422
db_url="postgresql://postgres:postgres@127.0.0.1:${db_port}/postgres"
scenario=""
if [[ "${1:-}" == "--scenario" ]]; then
  scenario="${2:?scenario name}"
fi

run_scenario() {
  psql "$db_url" -v ON_ERROR_STOP=1 -q -f "$repo_root/scripts/product-local/scenario-$1.sql"
  echo "Scenario applied: $1"
}

if [[ -n "$scenario" && -f "$work_root/accounts.env" ]]; then
  run_scenario "$scenario"
  exit 0
fi

mkdir -p "$work_root/supabase/migrations"
rm -f "$work_root"/supabase/migrations/*.sql
cp "$repo_root/supabase/baseline/${baseline_version}_public_schema.sql" \
  "$work_root/supabase/migrations/${baseline_version}_public_schema.sql"
while IFS= read -r migration; do
  cp "$migration" "$work_root/supabase/migrations/"
done < <(
  find "$repo_root/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | sort |
    awk -v cutoff="$baseline_version" '{ f=$0; sub(/^.*\//, "", f); v=f; sub(/_.*/, "", v); if (v > cutoff) print $0 }'
)
# Same prerequisite the baseline proof seeds: the four Walker admins the September grant expects.
cp "$repo_root/scripts/fixtures/walker-admin-grant.sql" \
  "$work_root/supabase/migrations/20260901212959_walker_admin_test_fixture.sql"

sed 's/project_id = ".*"/project_id = "exacth2o-product-local"/' "$repo_root/supabase/config.toml" > "$work_root/supabase/config.toml"
cat >> "$work_root/supabase/config.toml" <<EOF

[api]
port = ${api_port}

[db]
port = ${db_port}
shadow_port = 55420

[db.pooler]
port = 55429

[studio]
port = 55423

[inbucket]
port = 55424

[analytics]
port = 55427

[auth]
site_url = "http://127.0.0.1:4740"
additional_redirect_urls = ["http://127.0.0.1:4740"]

[auth.email]
enable_confirmations = false
EOF

supabase stop --workdir "$work_root" --no-backup >/dev/null 2>&1 || true
supabase start --workdir "$work_root" -x studio,imgproxy,edge-runtime,logflare,vector,supavisor,storage-api >/dev/null

eval "$(supabase status --workdir "$work_root" -o env | sed 's/^/export /')"
anon_key="${ANON_KEY:?}"
service_key="${SERVICE_ROLE_KEY:?}"
api_url="http://127.0.0.1:${api_port}"

psql "$db_url" -v ON_ERROR_STOP=1 -q -1 -f "$repo_root/scripts/product-local/seed.sql"

accounts_file="$work_root/accounts.env"
: > "$accounts_file"
chmod 600 "$accounts_file"
create_user() {
  local key="$1" email="$2" password
  password="local-$(openssl rand -hex 12)"
  curl -sS -o /dev/null -w '' -X POST "$api_url/auth/v1/admin/users" \
    -H "apikey: $service_key" -H "Authorization: Bearer $service_key" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\",\"email_confirm\":true}"
  printf '%s_EMAIL=%s\n%s_PASSWORD=%s\n' "$key" "$email" "$key" "$password" >> "$accounts_file"
}
create_user ADMIN admin@product.local
create_user RESEARCHER researcher@product.local
create_user VIEWER viewer@product.local
create_user OTHER other@product.local

psql "$db_url" -v ON_ERROR_STOP=1 -q -1 <<'SQL'
insert into public.portal_access (project_id, user_id, email, role)
select grants.project_id, u.id, u.email, grants.role
from (values
  ('admin@product.local', '22222222-2222-4222-8222-222222222222'::uuid, 'admin'),
  ('researcher@product.local', '22222222-2222-4222-8222-222222222222'::uuid, 'researcher'),
  ('viewer@product.local', '22222222-2222-4222-8222-222222222222'::uuid, 'viewer'),
  ('other@product.local', '55555555-5555-4555-8555-555555555555'::uuid, 'researcher')
) as grants(email, project_id, role)
join auth.users u on u.email = grants.email
on conflict do nothing;

insert into public.project_members (project_id, user_id, role)
select access.project_id, access.user_id, access.role
from public.portal_access access
where access.email like '%@product.local'
on conflict do nothing;
SQL

psql "$db_url" -v ON_ERROR_STOP=1 -q -1 -f "$repo_root/scripts/product-local/seed-commands.sql"

if [[ -n "$scenario" ]]; then run_scenario "$scenario"; fi

cat > "$repo_root/research-portal/.env.productlocal.local" <<EOF
VITE_SUPABASE_URL=${api_url}
VITE_SUPABASE_ANON_KEY=${anon_key}
EOF
printf 'API_URL=%s\nANON_KEY=%s\nSERVICE_ROLE_KEY=%s\nDB_URL=%s\n' "$api_url" "$anon_key" "$service_key" "$db_url" >> "$accounts_file"

cat <<EOF
Local product environment ready.
  API:       $api_url   (database $db_url)
  Accounts:  $accounts_file  (admin, researcher, viewer on the greenhouse project; other on a second project)
  Portal:    cd research-portal && npx vite --mode productlocal --host 127.0.0.1 --port 4740 --strictPort
  Scenario:  scripts/product-local/start.sh --scenario board-outage|controller-offline|discrepancy|normal
EOF

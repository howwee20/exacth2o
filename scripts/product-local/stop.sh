#!/usr/bin/env bash
# Stop the disposable local product environment started by start.sh (only that stack).
set -euo pipefail
work_root="${EXACTH2O_PRODUCT_LOCAL_DIR:-${TMPDIR:-/tmp}/exacth2o-product-local}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -f "$work_root/supabase/config.toml" ]]; then
  supabase stop --workdir "$work_root" --no-backup
fi
rm -f "$repo_root/research-portal/.env.productlocal.local" "$work_root/accounts.env"
echo "Stopped the local product environment."

#!/usr/bin/env bash
set -eu

if [ "$(id -un)" != "alarm" ]; then
  echo "Run this installer from the alarm account."
  exit 1
fi

app_root="$HOME/dev/pi-mfc-gui"
entrypoint="$app_root/pi-mfc-gui.py"
bridge_url="https://exacth2o.com/portal-app/gas-mixer-native-bridge.py"
bridge_fallback_url="https://raw.githubusercontent.com/howwee20/exacth2o/ej-supabase-research-portal/portal-app/gas-mixer-native-bridge.py"
bridge_sha256="2fe6b9cd7494f215fcd9d5d70a81c122006da54f27d600e916ea2b279ebcf78d"
state_root="$HOME/.local/state/exacth2o-gas-mixer-native-bridge"
backup_root="$state_root/backups/$(date +%Y%m%d-%H%M%S)"

test -f "$entrypoint"
mkdir -p "$backup_root"
cp -p "$entrypoint" "$backup_root/pi-mfc-gui.py"
if [ -f "$app_root/native_bridge.py" ]; then
  cp -p "$app_root/native_bridge.py" "$backup_root/native_bridge.py"
fi

download_verified_bridge() {
  curl -fsSL --connect-timeout 10 --max-time 60 "$1" -o "$app_root/native_bridge.py.new" &&
    printf '%s  %s\n' "$bridge_sha256" "$app_root/native_bridge.py.new" | sha256sum -c -
}

if ! download_verified_bridge "$bridge_url"; then
  echo "Primary download unavailable; using the pinned GitHub release."
  download_verified_bridge "$bridge_fallback_url"
fi
python3 -m py_compile "$app_root/native_bridge.py.new"
mv "$app_root/native_bridge.py.new" "$app_root/native_bridge.py"
chmod 600 "$app_root/native_bridge.py"

python3 - "$entrypoint" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
import_line = "from native_bridge import NativeBridge\n"
anchor = "from model import PiMfcGuiModel\n"
construction = "    native_bridge = NativeBridge(mfc_model, mfc_list, app)\n"
model_anchor = "            use_licor=False,\n            balance=balance)\n"

if import_line not in text:
    if anchor not in text:
        raise SystemExit("Expected Pi mixer import anchor was not found")
    text = text.replace(anchor, anchor + import_line, 1)
if construction not in text:
    if model_anchor not in text:
        raise SystemExit("Expected Pi mixer model anchor was not found")
    text = text.replace(model_anchor, model_anchor + "\n" + construction, 1)
path.write_text(text)
PY

python3 -m py_compile "$entrypoint" "$app_root/native_bridge.py"
# Preserve the first pre-bridge backup as the full rollback target. Record the
# newest upgrade backup separately for diagnosis without erasing that escape
# hatch on every update.
if [ ! -f "$state_root/last-backup" ]; then
  printf '%s\n' "$backup_root" >"$state_root/last-backup"
fi
printf '%s\n' "$backup_root" >"$state_root/last-update-backup"
sync
echo "NATIVE_BRIDGE_STAGED"
echo "The running mixer and existing screen agent have not been restarted or changed."
echo "Restart the Pi only during the supervised no-gas commissioning test."

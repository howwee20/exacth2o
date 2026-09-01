#!/usr/bin/env bash
set -eu

if [ "$(id -un)" != "alarm" ]; then
  echo "Run this rollback from the alarm account."
  exit 1
fi

app_root="$HOME/dev/pi-mfc-gui"
state_root="$HOME/.local/state/exacth2o-gas-mixer-native-bridge"
backup_root="$(cat "$state_root/last-backup")"
test -f "$backup_root/pi-mfc-gui.py"
cp -p "$backup_root/pi-mfc-gui.py" "$app_root/pi-mfc-gui.py"
if [ -f "$backup_root/native_bridge.py" ]; then
  cp -p "$backup_root/native_bridge.py" "$app_root/native_bridge.py"
else
  mv "$app_root/native_bridge.py" "$app_root/native_bridge.py.disabled"
fi
python3 -m py_compile "$app_root/pi-mfc-gui.py"
sync
echo "NATIVE_BRIDGE_ROLLED_BACK"
echo "Restart the Pi during a supervised safe-state window to load the restored mixer entrypoint."

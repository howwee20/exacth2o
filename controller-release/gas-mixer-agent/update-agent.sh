#!/usr/bin/env bash
set -eu

if [ "$(id -un)" != "alarm" ]; then
  echo "Run this update from the alarm account."
  exit 1
fi

install_root="$HOME/.local/share/exacth2o-gas-mixer-agent"
state_root="$HOME/.local/state/exacth2o-gas-mixer-agent"
service_root="$HOME/.config/systemd/user"
autostart_path="$HOME/.config/autostart/exacth2o-gas-mixer-agent.desktop"
agent_path="$install_root/agent.py"
service_path="$service_root/exacth2o-gas-mixer-agent.service"
agent_url="https://exacth2o.com/portal-app/gas-mixer-agent.py"

mkdir -p "$install_root" "$state_root" "$service_root"
curl -fsSL "$agent_url" -o "$agent_path.new"
python3 -m py_compile "$agent_path.new"
chmod 700 "$agent_path.new"

if [ -f "$agent_path" ]; then
  cp -p "$agent_path" "$agent_path.previous"
fi
mv "$agent_path.new" "$agent_path"

cat >"$service_path.new" <<'EOF'
[Unit]
Description=ExactH2O Gas Mixer outbound bridge

[Service]
Type=simple
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/alarm/.Xauthority
ExecStart=/usr/bin/python3 /home/alarm/.local/share/exacth2o-gas-mixer-agent/agent.py
Restart=always
RestartSec=5
StandardOutput=append:/home/alarm/.local/state/exacth2o-gas-mixer-agent/agent.log
StandardError=append:/home/alarm/.local/state/exacth2o-gas-mixer-agent/agent.log

[Install]
WantedBy=default.target
EOF
mv "$service_path.new" "$service_path"
chmod 600 "$service_path"

if [ -f "$autostart_path" ]; then
  mv "$autostart_path" "$autostart_path.disabled"
fi

pkill -u "$(id -u)" -f '/exacth2o-gas-mixer-agent/agent.py' 2>/dev/null || true
sleep 1

if systemctl --user daemon-reload &&
  systemctl --user enable --now exacth2o-gas-mixer-agent.service &&
  sleep 3 &&
  systemctl --user is-active --quiet exacth2o-gas-mixer-agent.service; then
  echo "AGENT_SERVICE_OK"
  echo "The existing mixer application was not modified."
  exit 0
fi

if [ -f "$autostart_path.disabled" ]; then
  mv "$autostart_path.disabled" "$autostart_path"
fi
DISPLAY=:0 XAUTHORITY=/home/alarm/.Xauthority \
  nohup /usr/bin/python3 "$agent_path" \
  >>"$state_root/agent.log" 2>&1 </dev/null &
echo "AGENT_FALLBACK_OK"
echo "The user service was unavailable; the existing autostart fallback remains enabled."

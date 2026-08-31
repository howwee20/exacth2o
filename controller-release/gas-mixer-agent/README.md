# ExactH2O Gas Mixer Agent

This is the outbound-only bridge for the existing Walker Pi gas-mixer
touchscreen. The mixer application remains the source of truth and is neither
imported nor modified by this agent.

The deployed agent:

- captures the existing `800x480` X11 display with FFmpeg;
- sends changed PNG frames to the private `gas-mixer-frames` Supabase bucket;
- polls only for short-lived, normalized `tap` events;
- injects taps through the local XTEST extension;
- reports the session unavailable whenever the mixer process or graphical
  console is not active; and
- connects outbound over HTTPS, without exposing VNC, SSH, or a device port to
  the public internet.

## Installed Walker Pi paths

- Agent: `/home/alarm/.local/share/exacth2o-gas-mixer-agent/agent.py`
- Private configuration: `/home/alarm/.config/exacth2o-gas-mixer-agent/config.json`
- User service: `/home/alarm/.config/systemd/user/exacth2o-gas-mixer-agent.service`
- Log: `/home/alarm/.local/state/exacth2o-gas-mixer-agent/agent.log`

`update-agent.sh` upgrades an installed bridge without touching the mixer,
enables automatic restart through the user service, and retains the original
LXQt autostart path as a fallback when a user service is unavailable.

The private configuration contains the device credential. Only its SHA-256
hash is committed in the database migration. Never commit the plaintext token.

## Control boundary

The portal creates five-minute view or control leases and renews them while an
authorized portal page remains open. Only users with an explicit
`system_admin_installation_access` capability may create or renew them. A
single control session can be active, commands expire after ten seconds, and
the agent supports pointer taps only—no shell, keyboard, arbitrary MFC, GPIO,
or setpoint command is accepted.

Before testing control against attached gas hardware, put the chamber in its
approved non-actuating test condition. View-only verification does not actuate
the mixer.

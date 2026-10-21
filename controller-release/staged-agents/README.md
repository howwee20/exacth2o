# Staged chamber-agent clients (not installed, not published)

These clients are tested against the local stack and simulator but have
**not** been installed on, or verified with, the physical instruments. They
live here, outside the paths `research-portal/scripts/sync-*.mjs` copy into
`portal-app/`, so building the portal cannot publish them at the URLs the
mixer's update scripts download. The installed clients remain:

| Client | Installed version | Source |
|---|---|---|
| Gas-mixer native bridge | 2.1.2 | `controller-release/gas-mixer-native-bridge/native_bridge.py` |
| Gas-mixer screen agent | 1.0.1 | `controller-release/gas-mixer-agent/agent.py` |
| BEAGLE lighting bridge | 2.1.0 | `controller-release/lighting-bridge/` |

The cloud already supports both the installed clients and these staged ones;
no server change is needed to install or roll back a staged client.

## gas-mixer-native-bridge-2.2.0

What changes (network worker only; `NativeBridge`, the Qt model calls, the
balance/availability checks, expiry and revision rejection, and the
`applied`-not-`verified` receipt semantics are identical to 2.1.2 except
that receipt memory is bounded):

- One held `sync` request (protocol 2) carries heartbeat, newest state and
  pending receipts and waits up to 25 s for commands, over one reused HTTPS
  connection. Idle cost: about 3,500 invocations a day instead of ~5,200
  (2.1.2 against the held server) or ~17,000 (2.1.2 against the 2026-10-20
  server).
- A command arriving during the hold is returned within the server's wake-up
  latency (tens of milliseconds); receipts follow within about 1.5 s.
- A local touchscreen change interrupts the hold and is sent at once, so
  portal commands carry the current revision.
- Bounded memory: 64 queued commands (excess stays queued in the cloud),
  256 pending receipts, 512 remembered command ids.

Tests: `python3 -m unittest discover -s controller-release/staged-agents/gas-mixer-native-bridge-2.2.0 -p 'test_*.py'`
and the local benchmark `scripts/perf/agent-harness/run-scenario.mjs --native-bridge <path>`.

SHA-256 of `native_bridge.py`: `bcd22a61ff7daf7fe16c109a45e3c04382f3d5ad4c8eddb069939f256d00a20d`

### Supervised install (only during the no-gas commissioning window)

1. On the mixer, as `alarm`, back up the running bridge:
   `cp -p ~/dev/pi-mfc-gui/native_bridge.py ~/dev/pi-mfc-gui/native_bridge.py.2.1.2`
2. Copy this `native_bridge.py` to `~/dev/pi-mfc-gui/native_bridge.py.new`,
   check `sha256sum` against the value above, then
   `python3 -m py_compile ~/dev/pi-mfc-gui/native_bridge.py.new` and move it into place.
3. Restart the mixer application only in the supervised safe state. Confirm
   in the portal that the bridge reports `exacth2o-gas-mixer-native-bridge/2.2.0`,
   readiness is green, and the screen agent is unaffected.
4. With the chamber in its approved non-actuating test condition, send one
   reversible portal change and confirm it is applied locally and reported
   back; then restore the original value.

Rollback: move `native_bridge.py.2.1.2` back into place and restart in the
same safe window. The cloud continues to serve 2.1.2 unchanged.

## gas-mixer-agent-1.1.0 (screen/tap agent)

- One held `sync` (protocol 2) is the heartbeat, the tap poll and tap
  receipts. While no portal session is open it captures and uploads nothing
  and holds up to 25 s: about 3,500 invocations a day, no Storage writes and
  no ffmpeg runs, instead of ~5,300 calls and ~1,760 frame uploads a day for
  1.0.1 against the held server.
- When a session opens, the server wakes the held sync; the next sync carries
  a fresh frame (about a second), then one call per changed frame
  (~1.25 s) that also waits up to 1 s for taps.
- A tap id is executed at most once: an executed (or attempted) tap is
  remembered for 60 s, so a redelivered command after a lost receipt only
  resends the receipt. 1.0.1 could replay a tap if its receipt failed.
- Same capture, X11 tap injection, 800x480 geometry, lock file and process
  checks as 1.0.1.

Tests: `python3 -m unittest discover -s controller-release/staged-agents/gas-mixer-agent-1.1.0 -p 'test_*.py'`

SHA-256 of `agent.py`: `e49ea4fb0628634f72c42fa258b979ce0bc70bec088af70f6b523c5a59de74fe`

Install (supervised): copy over `~/.local/share/exacth2o-gas-mixer-agent/agent.py`
after backing it up, check the SHA-256, `python3 -m py_compile`, then
`systemctl --user restart exacth2o-gas-mixer-agent.service` (this agent does
not touch the mixer process). Rollback: restore the backup and restart the
same user service. Do not use `pi-agent-update.sh` for this version: it
downloads the published 1.0.1.

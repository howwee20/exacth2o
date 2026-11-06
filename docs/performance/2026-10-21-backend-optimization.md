# ExactH2O backend optimization (2026-10-21)

Follow-up to the 2026-10-20 Edge-invocation quota incident. Companion files:
[request inventory](2026-10-21-request-inventory.md) ·
[ranked findings](2026-10-21-findings.md) ·
[$25 operating budget](2026-10-21-operating-budget.md) ·
[benchmark results (machine-readable)](agent-benchmark-2026-10-21.json).

## In plain language

The chamber agents no longer knock on the cloud's door every few seconds.
Each idle request from the mixer and lighting software is now held open by the
server and answered the moment there is something to do: a command, an opened
live view, or someone looking at the chamber page. Postgres tells the held
request directly (`NOTIFY`), so commands arrive faster *and* far fewer
requests are made. The installed device software did not change; the server
just answers it differently, inside each client's own timeouts.

With every device online, the projected Edge invocations for a 31-day month
fall from about **1.76 million** (88% of the 2 million included) to about
**0.83 million** (42%), measured against the real installed clients. Command
delivery got faster at the same time: mixer commands reach the bridge in
~30 ms instead of ~0.8 s typical, lighting in ~1.1 s instead of up to 6 s,
touchscreen taps in ~26 ms. Nothing about irrigation, valves, schedules,
calibration, mappings or research data changed.

In production, with the gas mixer still offline, the first full hour after
deployment used 485 invocations instead of 759 (−36%): 18% of the monthly
quota at that rate, with no errors.

User-visible differences: chamber pages refresh status every 5 s when idle
(every second while a command is in flight), a live mixer screen view now
ends after a minute in a background tab or ten idle minutes, and switching
browser tabs no longer reloads the whole portal.

## What was wrong (measured)

- Three agents made 97.7% of calls in the incident sample. Re-measured with
  the real clients against the server deployed on 2026-10-20: 2,232 idle
  invocations per hour (1.66M per 31 days) before any person used anything.
- Researcher gas commands were slow and often expired: over 30 days, accept
  p50 6.3 s, p95 13.8 s; 15 of 70 commands (21%) expired at their 15 s TTL.
- The 2026-10-20 lighting pacing made lighting commands wait up to ~6 s.
- A left-open portal tab kept the mixer screen agent in its fast path (one
  September session lasted ~4.9 days at ~11k calls/hour).
- The two 5-minute Cron jobs made 576 Edge calls a day that did nothing.
- Every tab switch reloaded the full 72-hour readings window (dozens of paged
  requests, each with a CORS preflight) in every open tab.

## What changed

**Wake-ups instead of polling (server, live).** Triggers on command and
session inserts send `NOTIFY exacth2o_agent_wake '<agent>:<device>'`. Each held
agent request listens on its own short-lived, read-nothing Postgres connection
and re-reads the authoritative queue when woken. Notifications carry no
command data; lost, duplicated or reordered ones can delay work but cannot
create or replay it. If LISTEN is unavailable, every path falls back to the
exact 2026-10-20 behavior.

**Holds sized to each installed client.** Python clients (native bridge
2.1.2, screen agent 1.0.1, 20 s socket timeout): heartbeat, state, frame and
poll calls are each held up to 16 s while nobody is waiting. Java lighting
bridge 2.1.0 (12 s read timeout, 15 s readiness window): idle syncs held up to
9 s, 4 s while someone watches. Response bodies are byte-identical (the Java
client parses the literal `"command"` token, so no fields were added).

**Attention.** A command, an open screen session or a visible portal panel
sets `agent_attention_until`; agents answer promptly while it is in the
future. Status reads record viewer attention at most once per 15 s and never
wait on the agent's row lock. Attention is not a readiness signal.

**Safety boundaries kept.** Queue reads use fresh time on every read (an
expired command is never delivered); revision checks, receipts, the
applied-not-verified semantics, idempotency keys, one-active-valve
arbitration and the local irrigation state machine are untouched. Lighting
commands that arrive during a hold are not delivered from the stale snapshot:
the hold ends empty and the bridge re-syncs after its own 1 s sleep, so the
command is validated against fresh controller state exactly as before.

**Cron gates (live).** The two 5-minute jobs evaluate each function's own
skip rule in SQL and call pg_net only when there is work; any gate error
falls through to the previous call.

**Post-command health readback (live).** A readback that meets a busy ingest
lease waits for it (≤20 s, inside the executor's 30 s timeout) instead of
answering `202 deduplicated`, which the executor counted as a completed
readback.

**Portal (live).** Status polling 1 s only while a command awaits receipt,
otherwise 5 s; commands without a receipt after 30 s are shown as
unconfirmed instead of locking the control; live views end when unattended;
same-user auth events no longer reload every tab; analytics polls at its
5-minute server cache; sign-out clears the catalog and analytics cache.

**Monitoring and gates (live).** Hourly zero-invocation usage estimate in
the database; publishing now requires a verify job; CI fails on budget or
polling-loop regressions.

**Staged, not installed:** native bridge 2.2.0 and screen agent 1.1.0
(`controller-release/staged-agents/`). The mixer is offline and the installed
clients keep working unchanged.

## Before / after

Local benchmark, identical scenario (10 min idle, 14 min commands, 5 min
visible panel, 3 min live view, 4 min faults), real installed clients, local
stack matching production versions:

| Measure | Before (a36042ec) | After |
|---|---|---|
| Idle invocations, 3 agents | 2,232/h (1.66M/31 d) | 804/h (0.60M/31 d), −64% |
| Native mixer idle | 18,144/day | 5,184/day |
| Screen agent idle | 21,168/day | 5,472/day |
| Lighting idle | 14,256/day | 8,640/day |
| Native command → bridge | p50 772 ms · p95 1,882 ms | p50 30 ms · p95 1,600 ms |
| Native command → applied receipt | p50 2.79 s · p95 3.90 s | p50 2.08 s · p95 3.66 s |
| Lighting command → bridge | p50 2.94 s · p95 5.94 s | p50 1.08 s · p95 1.09 s |
| Lighting command → observed | p50 2.93 s · p95 5.93 s | p50 1.07 s · p95 1.08 s |
| Tap → screen agent | p50 267 ms · p95 583 ms | p50 26 ms · p95 98 ms |
| First frame after opening a view | 6.66 s | 0.195 s |
| Native state age seen by a viewer | p50 7.2 s · p95 13.3 s | p50 2.6 s · p95 7.5 s |
| Lighting state age seen by a viewer | p50 2.8 s · p95 5.7 s | p50 2.9 s · p95 3.1 s |
| Live view cost | 11,422 calls/h | 10,488 calls/h |
| API-role SQL statements (whole run) | 20,430 | 11,990 (−41%) |
| Commands: applied / observed / delivered | 37 / 37 / 33 | 38 / 38 / 35 (no losses) |

The native p95 (1.6 s) is the installed bridge's fixed 2 s wait between
cycles; the lighting ~1.1 s is its fixed 1 s sleep. Sub-second p95 for those
two paths needs the staged clients (2.2.0 removes the wait; a lighting client
was not built). Total API-role SQL time rose from 1.0 s to 4.6 s only
because of the injected 8 s row lock; otherwise each statement averaged
~0.16 ms.

Production, read-only, after deployment:

| Measure | Before (03:00–04:00 UTC) | After (04:41–05:41 UTC) |
|---|---|---|
| Edge invocations in one hour (gas mixer offline) | 759 | 485 (−36%) |
| 31 days at that rate | 564,696 (28% of quota) | 360,840 (18%) |
| `lighting-native-agent` | 586 calls, p50 5.12 s | 338 calls, p50 9.14 s, max 9.70 s |
| `receive-walker-telemetry` | 120 | 118 (unchanged) |
| `sync-owner-health` | 41 (12 from Cron, all `202` no-ops) | 29 (none from Cron) |
| `assistant-automation-runner` | 12 (Cron, nothing to do) | 0 |
| HTTP errors · function warnings or errors | 0 · 0 | 0 · 0 |
| Wake-up latency (NOTIFY → response) | — | 15 ms |
| Health ingestion | every ~2 min | every ~2 min (unchanged) |
| Controller / config hash / health | RUNNING / 3a68b215… / OK, 20/20 sensors | identical at 05:32 UTC |

The first request after the lighting function was replaced took 13.7 s,
longer than the Java bridge's 12 s read timeout: the bridge logged one
failed sync and resumed on its own. All 382 later requests up to 05:41
returned 200 within 9.7 s. A future redeploy of that function may cause the
same single retry. The new usage monitor's first reading (05:07 UTC)
estimated 290 calls where the logs counted 273 for the same window.

Full 31-day projections, all devices online, installed clients
(`scripts/budget/edge-budget-model.mjs`):

| Profile | Before | After |
|---|---|---|
| Normal (supported workload) | 1,756,120 (88%) | 831,331 (42%) |
| Busy | 2,020,261 (101%) | 1,268,549 (63%) |
| Normal, wake-ups unavailable | — | 1,500,213 (75%) |

Database: 2.81 GB of 8 GB. Realtime, egress, storage and MAU were far
below quota before and are unchanged or lower; no new Realtime channels or
connections were added (wake-ups use Postgres, not Realtime).

## Tests

| Suite | Result |
|---|---|
| `verify.yml` in GitHub CI on the branch (all policy tests, controller packages, `deno check` of every function, database baseline restore, portal build and committed-artifact check) | passed: run 39544435738 |
| Same 66 commands locally | 63 passed; 3 failed only because `i2c-bus` cannot compile against this Mac's SDK; in a Linux Node 20 container that package installs, passes 62/62 and builds |
| `./scripts/verify-database-baseline.sh` (fresh restore of baseline + all migrations) | passed |
| Portal: lint, 410 unit tests, build, surface audit, production dependency audit | passed, 0 vulnerabilities |
| New SQL suites: `agent_wake_attention`, `cron_edge_gates`, `edge_usage_monitor`; existing access suites | passed, also after rollback and re-apply |
| Shared agent/wake/budget Node tests | passed (29 + 6) |
| Native bridge 2.1.2 (7), staged 2.2.0 (17), staged screen 1.1.0 (7), health (8 + 2), sync-owner-health policies (16) | passed |
| Publish gate on the production push | verify 64 s, deploy succeeded (Pages run 39545812232) |

Failure injection (benchmark): every LISTEN connection killed mid-hold →
the next command still arrived via the 2 s fallback (2.0 s); an 8 s row lock
on the mixer state → command delivered in 34 ms after release; a command
that expired before delivery → never delivered, marked expired. Unit tests
cover lost/duplicate wake-ups, aborts, listener loss, expiry at millisecond
precision, protocol-2 bounds, receipt retries, bounded queues and tap
non-replay.

Not run: the Playwright cross-browser suite (manual workflow; it covers
public pages and the demo rather than the changed chamber view). No
actuator command was sent to any real device.

## Evidence levels

| Claim | How it is known |
|---|---|
| Invocation reductions, command latency, expiry safety, response compatibility | Local: the real installed clients (Python 2.1.2 / 1.0.1, Java 8 lighting 2.1.0) against a local stack with production's versions |
| Listener loss, row lock, command expired on arrival, lost or duplicate wake-ups | Simulated: benchmark fault injection and unit tests |
| Lighting hold and spacing, wake latency, LISTEN connectivity, Cron gates, unchanged health ingestion, portal bundle, invocation rate | Deployed: production, read-only observation |
| Gas-mixer paths in production | Deployed, not exercised: the mixer is offline |
| Physical feedback (gas flow, light output) | Not measured: no actuator command was authorized; receipts still mean "applied, not verified" |
| Chamber view in a signed-in browser | Pending: needs a signed-in person |
| Staged clients 2.2.0 / 1.1.0 | Local tests only; not installed |

Command latency stages: API acceptance (the control functions are unchanged
and were not re-measured), queue pickup ("→ bridge" above), application
acknowledgement ("→ applied receipt" / "→ observed"), physical feedback (not
measured).

## Deployment record

| Item | Production |
|---|---|
| Migrations | `20261021043151_agent_wake_and_attention`, `20261021043212_gate_cron_edge_invocations`, `20261021043233_edge_usage_monitor`; stored SQL identical to the repo files |
| Edge Functions | `lighting-native-agent` v9 (04:33 UTC), `gas-mixer-native-agent` v11 and `gas-mixer-agent` v9 (04:40), `sync-owner-health` v45 (04:40); every bundled file read back identical; `verify_jwt` unchanged (false) |
| Portal | `ej-supabase-research-portal` `a36042ec → a8faaabd`; Pages run 39545812232; live `portal-app/assets/portal-PNZBG_9d.js` sha256 `8e274e04bc954afd9bd790fc713e641582951cb788eb495acc8620c0f6f22391` matches the build; published device files unchanged |
| PR | https://github.com/howwee20/exacth2o/pull/25 |
| Usage monitor | Cron `exacth2o-edge-usage-observation` hourly at :07 |
| Billing | Pro, spend cap enabled, cycle 21 Oct – 9 Nov; no billing setting changed |

Not deployed: device clients (mixer offline; BEAGLE not reachable from here),
Cron history pruning (needs approval), Walker heartbeat (needs approval).

## Rollback

1. Functions: redeploy the previous versions from a checkout of `a36042ec`
   (every file of the previously deployed versions was compared and equals
   that commit). The previous code needs none of the new schema.

   ```bash
   git worktree add ../exacth2o-rollback a36042ec
   ```

   Then, inside that worktree, for each of `lighting-native-agent`,
   `gas-mixer-native-agent`, `gas-mixer-agent` and `sync-owner-health`:

   ```bash
   supabase functions deploy lighting-native-agent --project-ref zmhdclcjrkntrpynozvo --use-api --no-verify-jwt
   ```
2. Database: run `supabase/rollbacks/20261021_backend_optimization.sql`
   after step 1 (SQL editor or `psql` as the database owner; it sets a 2 s
   lock timeout, so it fails fast instead of blocking agents). Verified
   locally to restore hash-identical production definitions and remove every
   new object. Then mark the three migrations reverted in the migration
   history and revert their files in the repository:

   ```bash
   supabase link --project-ref zmhdclcjrkntrpynozvo
   ```

   ```bash
   supabase migration repair --linked --status reverted 20261021043151 20261021043212 20261021043233
   ```
3. Portal: revert the PR's commits on `ej-supabase-research-portal`; the
   publish gate rebuilds and verifies before deploying.

## Remaining work and blockers

- **Gas mixer offline** since 2026-10-20 20:12 UTC; server support for both
  the installed and staged clients is live. Smallest next step: someone at
  the mixer restores power/network/session; the installed clients then run
  against the new server with no change. Installing 2.2.0 / 1.1.0 is a
  separate supervised step (`controller-release/staged-agents/README.md`).
- **Lighting** stays at ~8.6k calls/day until a protocol-2 lighting client
  exists (Java 8 hot-attach release on BEAGLE).
- **Decisions needed:** Cron run-history retention (deletes old pg_cron logs);
  Walker heartbeat 30 → 120 s (restarts its publisher container); the
  duplicate live-reading mirror (research-data decision).
- **Regressions are caught by:** the publish gate (tests and reproducible
  build), `scripts/budget/edge-budget-model.test.mjs` (budget, per-agent
  idle limits, polling-loop registry, agreement with the committed
  benchmark), the hourly database usage estimate, and the on-demand log
  audit. No email or chat alert is installed.

# ExactH2O $25 operating budget (2026-10-21)

The organization is on the Supabase Pro plan ($25/month) with the **spend cap
enabled**. That plan includes $10 of compute credit, which covers the single
active Micro database (~$10/month); the second project is paused and costs
nothing. Under the current footprint the bill stays at $25 as long as usage
stays inside the included quotas.

The cap is not a dollar ceiling. It stops billing for the metered items
below, and when one of them is exhausted Supabase restricts the project
(HTTP 402) until the next cycle. Since the grace period ended on 2026-10-20,
an overrun this cycle would restrict service immediately. Compute, custom
domains, IPv4, PITR, log drains and other opt-in add-ons are outside the cap;
none is enabled, and none should be enabled without a separate decision.

## Billing status (dashboard, read-only, 2026-10-20 22:28 EDT)

| Item | Observed |
|---|---|
| Plan | Pro, spend cap enabled |
| Current cycle | 21 Oct 2026 – 09 Nov 2026 (19 days), full 2,000,000 Edge quota |
| Invoices | 20 Oct $0.00 paid (two adjustments); 8 Oct $25.00 paid; 8 Sep $25.00; 8 Aug $25.04 |
| Projects | `zmhdclcjrkntrpynozvo` active (Micro); `ncamuzuykxraricnvozj` paused |
| Grace period | ended 20 Oct; Fair Use restrictions apply on overrun |
| Re-checked 2026-10-21 ~05:00 UTC | 2,270 of 2,000,000 Edge invocations used this cycle, no overage (the usage page refreshes up to hourly) |

No plan, cap, compute or add-on setting was changed for this work.

## Quotas and where this deployment stands

| Meter (Pro) | Included | Before (projected 31 days) | After (projected 31 days) |
|---|---|---|---|
| Edge Function invocations | 2,000,000 | 1.76M normal / 2.02M busy (88% / 101%) | 0.83M normal / 1.27M busy (42% / 63%) |
| Realtime messages | 5,000,000 | ~5k per cycle observed | unchanged (no new channels; wake-ups use Postgres NOTIFY) |
| Realtime peak connections | 500 | ≤ a few portal tabs | unchanged |
| Egress | 250 GB | 11.9 GB last cycle | lower (fewer status reads, no hidden-tab frames) |
| Database disk | 8 GB | 2.81 GB used | growth ~15 MB/day, ~11 months of headroom |
| Storage | 100 GB | one 800×480 PNG | unchanged |
| Log ingestion (billing starts 2027) | 20 GB | 29.2 GB last cycle | fewer agent REST calls; verify on the usage page |

Measured in production with the gas mixer offline: 759 invocations in the
hour before deployment, 485 in the first clean hour after it (−36%), or
360,840 (18%) for a 31-day month at that rate.

"Before" is the server deployed on 2026-10-20 with all devices online;
"after" is this change with the **installed** device clients. Both come from
`scripts/budget/edge-budget-model.mjs`, which reads the clients' own timing
constants and was checked against the real clients in
`docs/performance/agent-benchmark-2026-10-21.json`.

## Supported workload

The "normal" profile is the supported workload and keeps at least 40%
headroom under every quota:

- Devices: one gas-mixer native bridge, one screen agent, one BEAGLE lighting
  bridge (installed versions 2.1.2 / 1.0.1 / 2.1.0), the Matt irrigation
  controller (executor, publisher, 120 s owner-health watchdog), the Walker
  telemetry publisher (30 s heartbeat), and the GitHub watchdog.
- People: up to 2 hours/day of a visible chamber panel per device, 10 minutes
  a day of the live mixer screen view, 30 commands a day.
- Observed for comparison: 5 minutes of live screen view in the last 30 days,
  58 mixer commands in 10 days and 51 lighting commands in 30 days.

"Busy" (8 h/day of visible chamber panels, 60 min/day of live screen view,
150 commands/day) projects to 1.27M (63%): inside the quota, above the 40%
headroom target. The live screen view dominates heavy use: the installed
screen agent makes ~8,300 calls per viewing hour.

## Where $25 and uninterrupted service stop being compatible

With today's clients and server, the 2,000,000 invocations run out at roughly
any one of:

- ~140 hours of live mixer screen view per cycle on top of normal use
  (about 4.5 hours every day), or
- about 2.6 times today's agent fleet (a second lighting device and a second
  mixer pair still fit, at ~77% of the quota), or
- a production LISTEN failure (wake-ups unavailable) combined with busy use:
  normal use without wake-ups is 1.50M (75%).

Beyond that, the only options are to cut traffic further (staged clients,
below) or to accept usage billing by disabling the cap, which is a separate
decision with a cost of $2 per additional million invocations. Nothing here
disables the cap.

## Degraded and burst behavior

- Wake-ups unavailable: agents fall back to the 2026-10-20 behavior (bounded
  2 s re-checks, 5 s lighting pacing). Cost rises to ~1.5M/31 days for normal
  use; correctness is unchanged.
- Cloud unreachable: every installed client backs off (native 2–30 s with
  jitter, screen up to 15 s, lighting up to 20 s), so invocations fall during
  outages; reconnects resume the normal cadence one request at a time.
- Retry amplification: the Walker publisher retries every failed send five
  times, including 402 responses, so it bills ~5× during an outage (about 400
  extra calls in the 2026-10-20 restriction window). Fixing that needs a
  Walker device release.
- Quota pressure: automatic irrigation is local and unaffected; commands,
  safety checks and research ingestion keep their normal paths. Nothing
  silently drops scientific samples to save invocations.

## Monitoring

- **Installed with this change:** an hourly database job
  (`exacth2o-edge-usage-observation`) estimates invocations from
  `pg_stat_statements` counters of the one statement each agent, Walker and
  owner-health invocation runs (>98% of billed calls), projects 31 days, and
  records `ok` / `warn` (≥1.2M) / `critical` (≥1.6M). It costs no Edge
  invocation. Admins can read it with `edge_usage_budget()`. First reading
  (05:07 UTC, 34.5-minute window): 290 calls estimated against 273 counted
  in the logs (it reads about 6% high, so it warns early rather than late),
  projected 375,779 per 31 days, `ok`.
- **On demand:** `python3 scripts/audit-supabase-usage.py --project-ref zmhdclcjrkntrpynozvo --hours 24`
  reads the Logs Explorer (exact counts and HTTP errors).
- **In CI:** `scripts/budget/edge-budget-model.test.mjs` fails a change that
  pushes the supported workload above 1.2M, any agent above its idle budget,
  or adds an unregistered portal polling loop; the publish workflow runs it.
- **Not installed:** no email or chat alert is sent. The repository has no
  verified, authorized delivery channel (the notification dispatcher has no
  scheduler or verified sender), so alerts surface only through the database
  status and these checks. The billing dashboard remains authoritative. One
  option built on existing mechanisms: a scheduled GitHub Actions check that
  fails when the latest observation is `warn` or `critical`, since GitHub
  already emails failed runs to the repository owner. It needs a read
  credential for that one check, which is a separate decision.

## Remaining levers (not deployed)

| Lever | Saving per 31 days | Needs |
|---|---|---|
| Install staged native bridge 2.2.0 | ~50k, and command receipt p95 < 1 s | someone at the mixer, supervised restart |
| Install staged screen agent 1.1.0 | ~55k idle, ~65% of live-view cost | someone at the mixer |
| Lighting bridge with protocol 2 (not built) | ~160k | Windows access to BEAGLE and a hot-attach release |
| Walker heartbeat 30 s → 120 s (env var) | ~67k | approval; restarts the Walker publisher container |
| Walker: one send per scan, no retry on 4xx | up to ~200k while Walker is stopped | Walker device release |

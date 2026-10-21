# ExactH2O request and periodic-job inventory (2026-10-21)

Every automatic request path, timer, scheduled job and retention task found in
source (with file:line evidence in the audit notes) and checked against
production read-only (Logs Explorer, `pg_stat_statements`, `cron.job`,
`pg_publication_tables`). "Edge" means a billed Edge Function invocation;
"REST/RPC" is PostgREST (not an invocation, but it is database load and an
API-gateway log line). Rates are per day unless stated. "Before" is the
deployed 2026-10-20 server; "after" is this change.

## Architecture and data flow

```
 Lab devices (outbound HTTPS only)                Supabase project zmhdclcjrkntrpynozvo (Pro, Micro)
 ────────────────────────────────                ──────────────────────────────────────────────────
 Gas-mixer Pi (Arch, user alarm)
   pi-mfc-gui (Qt) + native bridge 2.1.2 ──► Edge gas-mixer-native-agent ─┐
   screen/tap agent 1.0.1 ───────────────► Edge gas-mixer-agent ─────────┤  service role
 BEAGLE Windows PC (legacy JVM)                                          │  (PostgREST)
   lighting bridge 2.1.0 (Java 8) ───────► Edge lighting-native-agent ───┤──► Postgres 17.6
 Matt irrigation Pi (Balena plain-feather)                               │     command queues,
   control_executor ─ RPC claim 5 s ─────► PostgREST (anon + device token)│     device state,
                    └ 120 s watchdog ────► Edge sync-owner-health ───────┤     sensor_readings,
   supabase_publisher ─ RPC device_ingest 30 s ─► PostgREST               │     cron, pg_net
   cron_svc (automatic watering, local only; no cloud dependency)        │       │
 Walker Pi: walker telemetry publisher ──► Edge receive-walker-telemetry ┘       │ NOTIFY (new)
                                                                                 ▼
 Browser portal (exacth2o.com/portal) ──► PostgREST RPC/reads, Realtime     held agent requests
   control actions ──► Edge *-native-control, gas-mixer-session,           wake on commands,
                       create-control-command, manual-hold                 sessions, viewers
 pg_cron: chamber_schedule_tick 5 s; owner-health and automation every 5 min (now gated)
 GitHub Actions: sync-owner-health watchdog twice an hour; Pages publish (now gated by tests)
```

The database queue is authoritative for every actuator command. A `NOTIFY`
on `exacth2o_agent_wake` only tells a held agent request to re-read it.

## Device and controller loops

| Source (owner) | Trigger | Calls (before → after) | Target | DB work per call | Failure behavior |
|---|---|---|---|---|---|
| Native mixer bridge 2.1.2 (mixer Pi) | heartbeat ≥10 s, state on hash change (live flows: every cycle), poll; 2 s wait | Edge ~17,200 → ~5,200/day idle | gas-mixer-native-agent | 2 REST (heartbeat/state), 2–3 REST + held wait (poll) | 2→30 s jittered backoff; acks retried; 20 s socket timeout |
| Screen agent 1.0.1 (mixer Pi) | heartbeat 10 s, changed frame 1.25 s, poll 0.5 s, loop 0.1 s | Edge ~19,000 → ~5,300/day idle; ~10,400 → ~8,300/h while a view is open | gas-mixer-agent (+ Storage upload) | 2 REST (+ Storage) per frame, 3 REST per poll | 1+n s backoff ≤15 s |
| Lighting bridge 2.1.0 (BEAGLE) | sync, then 1 s sleep | Edge ~14,100 → ~8,500/day | lighting-native-agent | 5 → 4 REST per idle sync | delay ×2 per failure ≤20 s; 12 s read timeout |
| Control executor 0.4.0 (Balena) | claim every 5 s; readiness 30 s; watchdog 120 s | RPC 17,280 + 2,880; Edge 720 | device_claim_control_command, device_report_control_executor_status, sync-owner-health | claim locks token row and writes `last_used_at` every call | fail-closed; 5→60 s backoff (no jitter); quarantine on uncertain outcome |
| Supabase publisher (Balena) | every 30 s, 1 s while catching up | RPC ~2,880 | device_ingest | inserts readings/valve events (on conflict do nothing); updates `devices` + `latest_device_state` even when empty | 2→60 s backoff, no limit |
| Walker telemetry publisher (Walker Pi) | heartbeat 30 s; 10-min scan, one call per sensor pair while Walker is STOPPED | Edge 2,880 (not stopped) to ~8,800 (stopped) | receive-walker-telemetry | 1 RPC with advisory lock | 5 attempts per send on any status (402/409 included) |
| Health service (Balena) | sampler 300 s | local only | — | — | — |
| Automatic irrigation (cron_svc, Balena) | local state machine | none | local API + Redis | one active valve, local pairing checks | independent of the cloud |

## Server-side scheduled jobs

| Job | Schedule | Before | After |
|---|---|---|---|
| `exacth2o-chamber-schedules` → `chamber_schedule_tick()` | 5 s | 17,280 runs/day; two index probes when idle; a `cron.job_run_details` row and two Postgres log lines per run | unchanged (retention proposed, not applied) |
| `exacth2o-owner-health-sync` → `invoke_owner_health_sync()` → pg_net → sync-owner-health | 5 min | 288 Edge/day, ~278 of them answered `202 primary_authority_fresh` | calls Edge only when the primary ingest is stale (observed ~10/day) |
| `exacth2o-assistant-automation` → `invoke_assistant_automation_runner()` → pg_net | 5 min | 288 Edge/day with zero schedules or monitors configured | calls Edge only when a schedule or monitor is due |
| `exacth2o-edge-usage-observation` (new) | hourly | — | zero-Edge usage estimate and status |
| GitHub `sync-owner-health.yml` | :17 and :47 | 48 Edge/day (+ up to 2 curl retries) | unchanged |
| GitHub `pages.yml` | push to production branch | published without tests | publishes only after the verify job passes |
| Health retention (`run_device_health_retention`) | inside watchdog ingests, ≤ once per 23 h | 30-day snapshot retention | unchanged |
| pg_net response cleanup | pg_net internal | 6 h TTL | unchanged |
| `cron.job_run_details` cleanup | none | 753,417 rows, 124 MB, +17.8k rows/day | proposed: hourly bounded prune keeping 7 days (needs approval) |

## Browser portal (one visible tab)

| Screen / source | Before | After | Edge? |
|---|---|---|---|
| Chamber: `gas_mixer_native_status` | every 1 s | 1 s only while a command awaits its receipt, else 5 s | no |
| Chamber: `lighting_native_status` | every 1 s | same as above | no |
| Chamber: `chamber_schedule_overview` | 5 s | 5 s while a schedule is enabled or running, else 15 s | no |
| Chamber: `gas_mixer_remote_status` | 15 s | 15 s | no |
| Mixer live view: frame image + lease renewal | ~1 frame/s and renewal forever, including hidden tabs | paused when hidden; session ended after 60 s hidden, 10 min without activity, page hide (keepalive) or unmount | renewal/end are Edge |
| Admin home: `website-analytics` tile | every 60 s (server cache 5 min) | every 5 min | yes |
| Web Analytics workspace | forced every 60 s | every 5 min | yes |
| Any tab switch (`SIGNED_IN`) and hourly `TOKEN_REFRESHED` | full reload in every tab: access checks, 72 h readings (≤50 pages, each with a CORS preflight), catalog | reload only for a different user or after an expired token | no |
| Readings/valves/health/device sync | 5 min (paused hidden) | unchanged | no |
| Realtime | device_health_snapshots, device_runtime_state, device_config_state, valve_events, support tables, pot notes | unchanged; note `sensor_readings`, `latest_device_state` and `project_control_commands` subscriptions receive nothing because those tables are not published | no |

## Edge Functions not driven by loops

`gas-mixer-native-control`, `lighting-native-control`, `gas-mixer-session`,
`create-control-command`, `manual-hold`, `experiment-builder`, `accept-invite`,
`submit-quote`, `submit-support-request`, `receive-support-email`,
`notification-dispatcher` (no scheduler configured): user-driven, together
≈40–100 invocations/day. `walker-mixer-session` (v5) is deployed but has no
source in the repository; it is not changed here.

## Storage, retention and data observations

| Object | Size / growth | Notes |
|---|---|---|
| `sensor_readings` | 1.90 GB (530 MB heap, 1.37 GB indexes), ~9,000 rows/day | Every live reading is stored twice: publisher `live-device:reading:<id>` and the sync-owner-health mirror `live-device:<device>:<sensor>:<time>` with an experiment-scoped pairing label (4,401/4,401 mirror rows in 24 h matched a publisher row exactly). Not changed: research data; needs a reviewed decision. |
| `sensor_readings_device_time_idx` | ~176 MB | Unused by every application read, but it is the only index serving the device foreign-key cascade. Not dropped. |
| `walker_live_telemetry_readings` | 336 MB | append-only by trigger |
| `device_health_snapshots` | 166 MB (mostly TOAST) | 30-day retention already runs |
| `cron.job_run_details` | 124 MB | no retention (proposal prepared) |
| `gas-mixer-frames` bucket | one `latest.png` overwritten | private, PNG only, 512 KiB limit |
| Realtime messages | ~4.7k/cycle earlier | well under 5M |
| Log ingestion | 29.2 GB last cycle vs 20 GB included; billing starts 2027 | every REST call from an Edge Function is a gateway log line |

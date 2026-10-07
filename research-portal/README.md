# exactH2O Research Portal

Authenticated researcher dashboard for the existing exactH2O Supabase project.

## What this is

- React/Vite frontend embedded in this website repo under `research-portal/`.
- Supabase Auth login using the browser-safe anon key.
- Invite-only account setup through a Supabase Edge Function. The browser sends
  an invite token, email, and password; the service-role key stays server-side.
- Portal settings can queue authenticated control commands through a Supabase
  Edge Function. The browser never writes hardware settings directly.
- Researchers retain experiment data, target editing, calibration, group creation,
  exports, and confirmed bounded manual-watering requests. Physical manual watering
  remains independently disabled until the controller timed-pulse bench gate passes. Pairing creation/removal,
  calibration deletion, board configuration, and system-level commands are enforced
  as admin-only by the Edge Function. Sensor initialization is locked for all portal roles.
- Dashboard queries the existing tables:
  - `pairings`
  - `sensor_readings`
  - `valve_events`
  - `latest_device_state`
  - `project_control_commands`
- Data source prefixes:
  - imported Matt/Balena rows: `balena-export-v2:%`
  - future live device rows: `live-device:%`

## Settings

Settings is written for a scientist or operator and uses the portal's own tile
language (paper background, white 8px tiles, slate text, tinted status pills, action
blue). Navigation: **Overview** and **Watering** (experiment), **Pairings**,
**Autocalibrate**, **Sensor calibration**, **Groups** (set up), **Exports** (data),
and **Hardware** under Advanced.

- Overview answers "is this experiment ready and what should I do next?": one next
  step, then Experiment, Watering, Sensors, and Pairings tiles. Support detail
  (controller last seen, reading counts, and the controller ID for administrators)
  sits behind "Advanced details".
- The controller's connection is stated once, in the header pill, including the
  time: "Controller offline · since 3:59 PM". There is no page banner. Values from a
  stale mirror are worded "when last seen".
- Beside any action that would only be queued while the controller is away, a
  contextual note says so, and a queued confirmation never reads as applied.
- Every change still goes through `create-control-command` with its role checks.

## Measurement semantics

The same rules apply to tiles, charts, tooltips, tables and health views
(`src/measurementFreshness.ts`, `src/seriesStatistics.ts`,
`src/targetPresentation.ts`, `src/commandLifecycle.ts`):

- **Freshness** comes from the newest measurement's own timestamp
  (`device_recorded_at`) judged against the pot's configured reporting interval:
  current within two intervals (at least 5 min), delayed within six intervals
  (at least 30 min), stale beyond that, each plus 2 min for upload; without a
  configured interval, 15 / 60 minutes and the label says the cadence is unknown. *Offline* comes only from controller
  presence (`state_fresh_until`), never from a failed browser request. Completed
  experiments are *historical*. When the portal last checked is shown separately
  and never makes an old reading look current. An experiment whose newest reading
  is current but whose other pots are not reads *N of M reporting* (state
  `partial`), and a group's "latest" median leaves out pots that stopped
  reporting, counting them instead. Ages within 5 minutes in the future read
  "just now" (the page clock ticks every 30 s); beyond that, a clock mismatch.
  Ages keep advancing while requests fail.
- **Statistics** use every valid reading. Drawing reduces points per pixel column
  while keeping each column's extremes, and breaks lines where readings stopped
  for longer than 2.5 intervals (or interval + 5 min). Missing values show as a
  dash, never zero. Missing-reading estimates use the configured cadence, or the
  observed one, labelled.
- **Targets** say what they mean: `Target 30% VWC`, `Target 0% VWC` (watering
  would only begin near 0%), `No target set`, `Watering disabled` (the controller
  rule: target outside 0–100%, zero valve time or zero interval), `Sensing only`,
  `Completed`. Charts draw the *current* applied target per treatment; the portal
  has no target history. Labels show the controller's applied target, which is
  what watering follows; when the experiment plan differs, every label says so
  (`Target 25% VWC · plan 30%`).
- **Requests** progress requested → queued → accepted → running → executed. A
  completed watering request reads "controller reported complete"; physical
  delivery is never claimed without flow, pressure or weight evidence. A reviewed
  settings change is a chain (stop, change(s), restore) and is reported step by
  step; if a step fails or expires after the stop ran, the panel says the
  controller is probably still stopped. Tracking stops after 15 minutes and says so.

## Loading and refresh

Settings (with calibration and commissioning), the experiment builder, System
Health, Sales & Support, Walker and Web Analytics load on first use behind
`FeatureBoundary` (loading state; on failure, an offer to reload the portal).
Polling for health, support, device state and the watchdog pauses while the tab
is hidden; returning to the tab triggers one incremental reconciliation (a full
reload after six hours away), and bursts of focus/visibility events are
coalesced. A trigger while hidden or offline does not use up the 30-second
spacing, and coming back online always reconciles. Watering history loads
incrementally only when some is already loaded, and reloads the full window when
an incremental page comes back full. Realtime readings are merged in 400 ms batches, full reconciliations
replace data only when complete, and responses for a previous session, project
or device are discarded. `scripts/perf/portal-lab/` measures these behaviours
against a counting mock.

## Autocalibrate (real hardware commissioning)

Autocalibrate finds out which valve physically waters which sensor. It is
production commissioning software: the operator selects pots, passes preflight,
confirms, and the portal pulses **one real valve at a time** while watching every
selected sensor. There is no simulated or demo mode in the product.

How it reaches hardware (`src/commissioning/`):

- **Pulses** are ordinary `manual_water` commands for exactly one pairing, sent
  through the authenticated `create-control-command` Edge Function
  (`supabasePorts.ts`). Every existing gate stays in force and is not bypassed:
  `CONTROL_COMMAND_INTAKE_ENABLED`, `MANUAL_WATER_INTAKE_ENABLED`, role policy, the
  database one-at-a-time and 60 s cooldown rule, the executor's
  `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN` and `EXACTH2O_MANUAL_WATER_ENABLED` gates,
  and the controller-owned `/valves/pulse` timer with its single-valve mutex. If
  any gate is closed the first pulse is refused, nothing is watered, and the run
  stops. The adapter only ever reads tables and invokes that one function.
- **Safe commissioning state** is controller `RUNNING` with automatic watering
  disabled on every selected pot. `STOPPED` pauses the controller's measurement
  loop, so no response could be measured. "Prepare the pots" queues one reviewed
  `bulk_update_pairings` (disable watering, measure every 60 s) and records the
  previous settings so they can be restored.
- **Orchestration** (`orchestrator.ts`): baselines, then per valve: interlocks,
  one bounded pulse, wait for the command's final status, observe all selected
  sensors, at most one longer retry, then flag. Interlocks are re-checked before
  every pulse: stop/abort, run time, pulse and water budget, stale controller,
  unsafe state, automatic watering re-enabled, conflicting watering command, silent
  sensor, unsettled sensors, and any command failure or timeout. A failed command
  is never retried. Leaving the screen aborts the run; nothing is scheduled ahead.
- **Rehearsal** runs the same orchestration against the live controller and
  sensors without sending any valve command. It cannot produce a mapping.
- **Evidence** keeps three facts apart for every pulse: command requested,
  controller acknowledged, measured sensor response. None is treated as proof
  that water reached a pot; physical validation is always shown as pending.
- **Applying** a reviewed mapping uses the existing reviewed settings batch
  (`topologyPlan.ts` -> `onQueueSettingsPlan`): stop, `delete_pairing` +
  `create_pairing` carrying the pot's settings and calibration, restore state,
  with the config-hash precondition and executor readback. The previous topology
  is stored in the run record and an exact rollback plan is offered after readback.
- **Records**: each run's full log and evidence are kept in the browser and can be
  downloaded as JSON. Each pulse's `operation_intent` carries the run ID, so it can
  be matched to `project_control_commands` and the platform operation ledger.

`src/autocal/` (seeded bench simulator and engine) and
`src/commissioning/testing/mockController.ts` are **internal test infrastructure
only**. Tests fail if product code imports them, and `audit:portal-surface` fails
the build if simulator copy appears in the shipped bundle. The Monday supervised
test procedure is in `docs/autocalibration-commissioning-checklist.md`.

## What this is not

- No service role key in the frontend.
- No open public signup that automatically grants project access.
- No fake live data. Autocalibrate never manufactures readings; when the live
  prerequisites are missing it reports why and stays unavailable.
- No direct browser-to-device irrigation actuation.
- No frontend mutation of valve mappings, calibrations, or board config.
- No device-side command executor in this static site; queued commands require
  a protected backend/device bridge to apply them to the controller.

## Local run

For the website entry point:

```bash
cd research-portal
npm ci
cp .env.example .env.local
# replace VITE_SUPABASE_ANON_KEY with the project anon key
npm run check
cd ..
python3 -m http.server 8123 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8123/portal.html`.

The build writes browser-ready assets to `../portal-app/`, and the website's
root `portal.html` loads those assets directly.

Production CI installs locked dependencies; runs frontend lint, unit tests, strict
type checking/build, command-policy tests, executor safety tests, Deno Edge Function
checks, and dependency audits; then fails when the committed `portal-app/` bundle
differs from the build output. Stable React, Supabase, and icon dependencies are
emitted as cacheable hashed chunks, and the entry is content-hashed too
(`assets/portal-<hash>.js`). Lazily loaded feature chunks import the entry by file name, so
the page must load it under exactly that URL; a `?v=` query on the entry would execute the
portal a second time when a feature loads. The build synchronizes the entry name,
module-preload links and a content-derived CSS cache token into the deployed root
`portal.html` wrapper.

For active React development:

```bash
cd research-portal
npm ci
cp .env.example .env.local
# replace VITE_SUPABASE_ANON_KEY with the project anon key
npm run dev
```

The portal uses snapshot mode automatically when no `live-device:%` rows are available.

## Invite access

Apply the `project_invites` migration and deploy the `accept-invite` Edge Function.
Create a Matt project invite from the Supabase SQL editor:

```sql
select *
from public.create_project_invite('person@example.com');
```

Send the returned `invite_url`. The raw token is only returned once; the database
stores only its SHA-256 hash.

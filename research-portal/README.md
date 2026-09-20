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

Settings is organized for researchers: **Overview** (controller presence and last
readings), **Hardware** (sensor and valve-output identities, kept apart from the
labels people assign), **Pairings** (which valve waters which pot), **Autocalibrate**,
**Watering**, **Sensor calibration**, **Groups**, and **Exports**. When the mirrored
controller state is past `state_fresh_until`, every page shows one offline banner and
values are worded as last known state. Every change still goes through the
`create-control-command` Edge Function with its existing role checks.

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
emitted as cacheable hashed chunks while `assets/portal.js` remains the fixed entry.
The build also synchronizes module-preload links and a content-derived JavaScript/CSS
cache token into the deployed root `portal.html` wrapper.

For active React development:

```bash
cd research-portal
npm ci
cp .env.example .env.local
# replace VITE_SUPABASE_ANON_KEY with the project anon key
npm run dev
```

The local-only R&D replay is available at `/?rd-preview=1`. It uses a synthetic
fixture generated by the private response-model repository. The preview branch is
compiled out of production builds, and the generated Pages bundle contains no
synthetic events, feature schema, model weights, or training code.

Production R&D access is deny-by-default. The portal invokes the protected
`rd-admin-lab` DTO function and does not select raw R&D tables. A portal `admin`
does not automatically receive R&D system-administrator capability.

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

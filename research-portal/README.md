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

## Autocalibrate (Settings → Autocalibrate)

Autocalibrate finds out which valve physically waters which pot, across the whole
installation (all 100 pots, a zone, or any selection). It is the one place a
researcher starts autocalibration: Settings → Autocalibrate, in installation and
experiment settings, for project researchers and administrators. Links lead there:
the home controller node ("Autocalibrate →"), Pairings ("Check with Autocalibrate"),
the Overview tile, and `?view=controller&settings=autocalibrate` (any section can be
linked with `settings=<section>`). Sensor calibration stays its own section.

Workflow (`src/autocalibrate/`, engine in `src/commissioning/`):

1. **Choose pots** on the aerial view (`product/AerialBench.tsx`, `aerialLayout.ts`):
   the PicoGrid overhead composition (four rows of 25, zones as interlocking 13 + 12
   blocks, nodes around the bench) when no bench layout is recorded, labelled
   schematic; the recorded layout when there is one, with unplaced pots listed.
   Tap/click, Space or Enter selects; arrow keys move; I opens a pot's details; zone
   chips select a zone; phones get one zone at a time with 44 px targets. Pots that
   cannot take part (no valve or sensor, a shared valve or sensor, a sensor that has
   stopped reporting) are drawn hatched with the reason. Researchers can mark
   known-correct reference pots (or use bench-confirmed ones). A selection never
   uses a pot's number or position as a hardware address: every pot carries its own
   pairing's sensor and valve keys.
2. **Prepare**: the server records every selected pot's settings (immutable
   `commissioning_sessions.original_snapshot`; pots an earlier session left
   sensing-only carry their real originals forward), then one reviewed
   `bulk_update_pairings` turns automatic watering off and measures every 60 s.
   Controller readback confirms it.
3. **Check and start**: rehearsal or real valves, safety checks (valid 5 minutes or
   until anything changes), typed confirmation `OPEN <n> REAL VALVES`.
4. **Run**: one bounded pulse at a time through `create-control-command`
   (`manual_water`, one pairing), every selected sensor watched on every pulse, so
   one response matrix covers the whole selection (crossings across zones, swaps and
   cycles of any length). The run is owned by this browser tab (`runStore.ts`): it
   continues while the operator uses other pages, a floating bar shows progress and
   **Stop** everywhere, and closing or reloading the tab stops it before its next
   pulse. One screen holds a run at a time (`claim_commissioning_run`); it renews
   that hold every 30 s and immediately before every pulse, so a screen that slept
   while another resumed cannot send a pulse, and "Ask that screen to stop" works
   from any other screen. Checkpoints of the evidence are saved every 2 minutes;
   an interrupted run resumes from them with fresh baselines.
5. **Review and apply**: matches, swaps and cycles (applied only as complete
   groups), unresolved valves and unreached pots with advice, weak-evidence matches,
   reference-pot checks. One `remap_pairing_valves` command moves every approved
   pot in a single controller transaction; readback must show it before pot records
   (`hardware_bindings`) move, marked software-only. Rollback is one command, verified
   the same way.
6. **Delivery at the bench**: operators record pots they watched being watered
   (`confirm_autocalibration_delivery`). The four facts stay separate: proposed,
   approved, controller-verified, delivery confirmed.
7. **Restore**: one `restore_pairing_settings` command returns each pot to its own
   recorded target, pulse length and interval; unresolved, unapplied or externally
   changed pots stay sensing-only (listed with the reason) unless released.

Manual watering interrupts autocalibration: a hold in this tab stops the run before
its next pulse (`controllerOwnership.ts`), a hold anywhere else is seen in
`manual_hold_sessions`, and the controller refuses or cuts short timed pulses while
manual control is active. Evidence overlapping manual watering is set aside and the
run must be resumed after the pots settle.

`src/autocal/` (seeded bench simulator) and `src/commissioning/testing/mockController.ts`
are **test infrastructure only**; `audit:portal-surface` fails the build if simulator
copy ships. The browser preview with a simulated 100-pot controller is
`browser-tests/autocal-harness.html` (see Local run). The supervised hardware
procedure is `docs/autocalibration-commissioning-checklist.md`.

## Manual watering (troubleshooting)

**Manual water** in the header (desktop and phone), on each pot page, in field mode,
and in Autocalibrate's pot details opens one panel: **By solenoid** (any configured
output, by its recorded solenoid number or board:channel, with its board, channel and
associated pot when a recorded route knows it) or **By pot** (a physical pot through
its recorded route). Every entry uses the same `HoldWaterControl`: press and hold to
water, release to stop. Mouse, touch, pen, Space and Enter each own the hold they
start (`holdInput.ts`); lost capture, blur, a hidden page, Escape or a changed
destination end it.

The controller owns the valve (`ManualHoldManager`): a session opens only on a start,
is kept open by renewals every 0.5 s against a 2.5 s monotonic lease, and closes on
release, on lease expiry (also with no network), on a continuous-on limit if one is
configured, or when another operator takes over (closing the first hold before the
next opens). There is no fixed 15-second cap. Status words are what the controller
reports: Ready, Taking control, Opening, Controller: open, Stopping, Controller:
closed, Unconfirmed, In use, Fault. A hold overrides targets, schedules and
automatic-watering rules for that hold only; saved settings are unchanged.

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

Production CI uses Node.js 24 LTS, installs locked dependencies, audits all portal dependencies,
including development tools; runs frontend lint, unit tests, strict type
checking/build, the portal surface audit, and selected agent/bridge tests; then
fails when committed release files differ from the build output. The broader
command-policy, executor safety, and Deno Edge Function checks run in the manual
release-verification workflow. Stable React, Supabase, and icon dependencies are
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

Autocalibrate and manual watering against a simulated 100-pot controller (no
network, no hardware: every Supabase and hold request is served inside the page by
`browser-tests/fake-backend.ts`, and anything else is refused):

```bash
cd research-portal
VITE_SUPABASE_URL=http://127.0.0.1:9/preview-blocked VITE_SUPABASE_ANON_KEY=preview-only npx vite --host 127.0.0.1 --port 5179
```

Then open `http://127.0.0.1:5179/browser-tests/autocal-harness.html`. The clock
buttons (×1, ×60, ×600) run the simulated controller faster, so a ten-hour 100-pot
run completes in about a minute; `?preset=issues` adds a silent sensor and a shared
valve; `?role=viewer` shows the access refusal. `npx playwright test
browser-tests/autocalibrate.spec.ts browser-tests/hold-control.spec.ts` runs the
same flows in Chromium, Firefox and WebKit (`AUTOCAL_SCREENSHOT_DIR=<dir>` saves
screenshots). Browser emulation is not a physical phone test.

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

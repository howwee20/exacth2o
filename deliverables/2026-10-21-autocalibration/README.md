# Full-scale Autocalibrate and hold-to-water troubleshooting (2026-10-21)

Branch `claude/aerial-autocal-manual-hold`, from `ej-supabase-research-portal` at
`49755782`. Original Opus handoff: the implementation was not yet committed or deployed. See
`release-status.md` for subsequent release verification. No valve was opened and no live target
was changed while building or testing this; every actuation test used simulated
outputs.

## What a researcher does now

**Autocalibrate** is Settings → Autocalibrate (installation or experiment settings,
researchers and administrators). Links lead there from the home controller node,
Pairings ("Check with Autocalibrate"), the Overview tile, and
`/portal?view=controller&settings=autocalibrate`.

1. **Choose pots** on the overhead view of the bench: four rows of 25 with the zones
   as interlocking 13 + 12 blocks and their nodes around the bench (the PicoGrid
   composition, labelled schematic), or the recorded bench layout when one exists.
   Select all 100, a zone, an experiment's pots, or single pots (click, tap, Space or
   Enter; arrow keys move; I opens details). Pots that cannot take part are hatched
   and say why. Known-correct pots can be marked as references.
2. **Prepare**: the server records each pot's exact settings, then one reviewed change
   turns automatic watering off and measures every 60 s; controller readback confirms.
3. **Check and start**: rehearsal or real valves; safety checks; typed confirmation.
4. **Run**: one bounded pulse at a time, every selected sensor watched on every pulse.
   Progress, the pot and valve being tested, counts, budgets and **Stop** are on the
   page and in a floating bar on every portal page. The run belongs to the browser tab
   (closing it stops the run before its next pulse) and is saved at checkpoints, so an
   interrupted run resumes from its evidence with fresh baselines.
5. **Review and apply**: matches, swaps and cycles (any length, applied whole or not at
   all), unresolved valves and unreached pots with advice, weak evidence, reference
   checks. One controller transaction applies the approved groups; readback must
   confirm before pot records move. One-command rollback.
6. **Confirm delivery at the bench** for pots you watched being watered.
7. **Restore** every pot to its own settings; unresolved or unapplied pots stay
   sensing-only with the reason, and their originals carry into the next session.

The four facts stay separate everywhere: proposed (measured), approved (you),
controller-verified (readback), delivery confirmed (operator at the bench).

**Manual water** (header on desktop and phone, field mode, pot pages, Autocalibrate's
pot details) opens one panel: **By solenoid** (any configured output 1–100 by its
recorded number or board:channel, with board, channel and associated pot when a
recorded route knows it) or **By pot**. Press and hold to water for as long as needed,
release to stop. The controller keeps the valve open only while renewals arrive
(0.5 s renewals, 2.5 s lease) and closes it on its own if they stop. Manual watering
in a tab stops that tab's autocalibration first; manual watering anywhere sets aside
overlapping evidence and stops the run.

## Screenshots (simulated 100-pot controller)

`screenshots/`: aerial selection of all 100 (Chromium, Firefox, WebKit), phone
selection (390 px, touch emulation in all three engines), run progress at 36 of 100
valves, results (2 swaps and a 3-pot cycle found, one disconnected hose unresolved),
the applied change verified by readback, and the restored state. Phone screenshots
are browser emulation, not a physical phone.

## Local preview

```bash
cd research-portal
VITE_SUPABASE_URL=http://127.0.0.1:9/preview-blocked VITE_SUPABASE_ANON_KEY=preview-only npx vite --host 127.0.0.1 --port 5179
```

Open `http://127.0.0.1:5179/browser-tests/autocal-harness.html` (×1/×60/×600 clock
buttons; `?preset=issues`; `?role=viewer`). All backend calls are served in the page
by a simulated controller; anything else is refused.

## Test and build results

| Suite | Result |
|---|---|
| Portal unit tests (vitest) | 57 files, 488 tests passed |
| Portal lint (`eslint --max-warnings=0`) and type-check (`tsc -b`) | clean |
| Browser tests, Chromium/Firefox/WebKit | 48 passed, 6 skipped by design (the two long simulated runs run in Chromium only) |
| Full simulated 100-pot workflow in the browser | passed (prepare → run → apply verified by readback → restore) |
| Release build (`node scripts/build-product-release.mjs`) and `audit:portal-surface` | passed |
| Controller cron service (jest) | 12 suites, 92 tests passed; `tsc` clean |
| Controller API (jest) | 4 suites, 15 tests passed; `tsc` clean |
| Control executor | 36/36 (package), 37/37 (Balena release copy) |
| Edge Function policy tests | 31 passed; `deno check` clean for both functions |
| Database: baseline restore + every migration + all regression files | passed in a disposable local stack (own project id, ports 56320–56329) |
| Database: rollback, re-apply, idempotent re-apply | passed |

Portal entry bundle: 355 kB (was 324 kB); the engine, workspace and troubleshooting
panel load on first use. Not run here: `responsive.spec.ts` (its server port belongs
to another checkout's preview server, which was left alone).

## Deployment order

1. **Database**: `supabase db push --dry-run`, review, then apply
   `supabase/migrations/20261021160000_full_scale_autocalibration_and_manual_hold.sql`.
   Additive. Rollback: `supabase/rollbacks/20261021_full_scale_autocalibration_and_manual_hold.sql`
   (download session records first; completed remap/restore commands stay as history).
2. **Controller release** (`controller-release/matt-balena-release-4174753`, fleet
   `basyalbi/matt`): `balena push`. New: renewable hold sessions and arbitration in
   `cron_svc`, remap/restore routes in `api_svc`, executor v0.5.0, the `valve_watchdog`
   service. Set `EXACTH2O_MANUAL_HOLD_SECRET` (cron, health, Edge Function) and
   `EXACTH2O_CONTROLLER_COMMAND_SECRET` (cron, watchdog). Leave
   `EXACTH2O_MANUAL_HOLD_ENABLED` and the command gates closed until the bench checks.
3. **Edge Functions**: deploy `create-control-command` and `manual-hold`.
4. **Portal**: commit source with the regenerated `portal-app`, `demo-app`,
   `applications-demo-app`, `portal.html`, `demo.html` (the build in this worktree
   already produced them) and push to `ej-supabase-research-portal`.
5. **Bench acceptance** and gate opening: `docs/autocalibration-commissioning-checklist.md`.

Jake's access: holds and Autocalibrate require a project `researcher` or `admin` row
in `portal_access`; check it before acceptance (no account was created or assumed):
`select role from portal_access where email = '<Jake's address>' and access_scope = 'project';`

## Physical acceptance still to do

Everything in the checklist's sections 1–4, in particular: a hold past 15 s on the
real valve, valve closure on network loss, the watchdog dropping every relay when
`cron_svc` stops (RESET wiring on GPIO 16), a real-phone press-and-hold, takeover
between two operators, a supervised Autocalibrate run with an eye on every emitter,
then applying, bench confirmation and restore.

## Found along the way

- Fixed: incomplete observations were treated as "no response" on resume (could
  trigger an unneeded retry pulse); sensor cadence right after preparation was judged
  by old 10-minute readings, so the safety checks blocked with misleading advice.
- Fixed earlier in this work: telemetry stalled past 1,000 rows (PostgREST page cap);
  100-sensor settle checks timed out on noise alone; executor sensor lookup was
  case-insensitive; relay cleanup wrote the wrong level for active-low boards.
- Pre-existing: the previous manual-hold function wrote audit rows the service role
  cannot insert; the new function records holds in `manual_hold_sessions` instead.

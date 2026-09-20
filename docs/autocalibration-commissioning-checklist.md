# Autocalibrate: first supervised hardware test (10–20 pots)

This is the first time Autocalibrate opens real valves. Software tests, the
build, and the deployment prove the code path, not the bench. Treat every
result as unvalidated until it is confirmed by eye.

Two people: one at the bench with a hand on the water shutoff, one at the portal.

## 0. Gates the platform owner must open first

Autocalibrate sends ordinary bounded `manual_water` commands, so it is blocked by
the same gates as manual watering. They are closed by default and are **not**
opened by this release. Follow `controller-release/control-executor/README.md`
("Verification plan before live deploy", steps 7–9) and `platform/OPERATIONS.md`.

- [ ] Controller release with the timed-pulse endpoint (`POST /v1/valves/pulse`,
      `ManualPulseManager`) is the one actually running on the device.
- [ ] Timed-pulse bench protocol passed: short pulse, executor killed mid-pulse,
      API container killed mid-pulse, power loss. Valve closed on the
      controller's own deadline every time.
- [ ] Executor live: `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN=0`, fresh heartbeat.
- [ ] Executor pulse gate: `EXACTH2O_MANUAL_WATER_ENABLED=1` (separate reviewed change).
- [ ] Edge Function secrets: `CONTROL_COMMAND_INTAKE_ENABLED=1`, `MANUAL_WATER_INTAKE_ENABLED=1`.
- [ ] Command queue empty; device not quarantined.

If any of these is closed, preflight or the first pulse is refused, nothing is
watered, and the run stops. That is the expected fail-closed result, not a bug.

## 1. Physical prechecks at the bench

- [ ] 10–20 pots chosen, each with one sensor and one emitter; nothing shared.
- [ ] Every emitter is in a pot or a catch cup. No open hose ends.
- [ ] Supply pressure normal; manual shutoff reachable; towels and a tray ready.
- [ ] Pots are **not** freshly watered or saturated (below ~40% VWC) and have not
      been watered in the last 30 minutes.
- [ ] Pots outside the selection will not be watered automatically during the
      test, or are physically isolated. The controller refuses overlapping
      valves, which would stop the run.
- [ ] Write down today's pairing table (download "Pairings CSV") and photograph
      the bench labels.

## 2. In the portal (Settings → Autocalibrate, administrator)

1. Select the 10–20 pots. Check each valve and sensor identity against the label.
2. Limits for the **first** run:
   - Diagnostic pulse: **3 s** (do not start higher; hard maximum is 10 s).
   - One retry pulse: **6 s** (hard maximum 15 s).
   - Water budget: pots × 9 valve-seconds (20 pots → 180; hard maximum 300).
     The run stops by itself before any pulse that would exceed it.
3. Prepare the pots: queue the reviewed change that disables automatic watering
   and sets measurement to every 60 s on the selected pots. Wait until the
   table shows "Disabled" and "Every 60s" for all of them and the controller
   is RUNNING again.
4. Run preflight in **Rehearsal** mode and start the rehearsal. Expect: every
   check passes, baselines for every sensor, each valve walked, "Not sent" for
   every command, no water anywhere. Download the log.
5. Switch to **Open real valves**, run preflight again. Every blocking check
   must pass. The "controller executor" line is always a note: that gate cannot
   be read from the portal and is proven by the first pulse.
6. Consider a 2-pot real run first. Then the full selection.
7. Type the confirmation phrase exactly and start. Stay at the bench.

## 3. What correct evidence looks like

For each valve, in order, and never two at once:

- "Command requested" with a command ID, then "Controller acknowledged" within
  about a minute. Acknowledged means the controller accepted the timed pulse. It
  does not mean water reached a pot.
- At the bench: exactly one emitter runs for about 3 s, then stops on its own.
  **Note which pot it was.** This is the ground truth the software cannot see.
- A few minutes later: one sensor rises (typically +0.5 to +4% VWC) and stays
  up; every other sensor stays flat.
- At least ~65 s between pulses (server cooldown) plus the observation time.
- At the end: a proposed mapping per valve with a confidence, or an explicit
  unresolved reason. Active pairings are unchanged.

## 4. Abort criteria — press **Stop now**, then close the manual shutoff if water is flowing

- An emitter runs longer than the requested pulse plus 2 s.
- More than one emitter runs at once, or an emitter outside the selection runs.
- Water anywhere it should not be; any leak; a pot overflowing.
- The portal shows a second valve active, or pulses closer together than ~65 s.
- The controller goes offline, or the page loses connection during a pulse.
- A sensor jumps by more than ~6% VWC from one pulse.

The software also stops by itself on: command failure or no final status,
stale controller, controller not RUNNING, automatic watering re-enabled,
another watering command queued, a silent sensor, sensors that never settle,
budget or time limit. After any stop with an "unknown outcome", confirm by eye
that every valve is closed before doing anything else. If the device was
quarantined, use the documented reconciliation procedure; do not retry.

## 5. Before accepting any mapping

- [ ] For every proposed mapping, the pot you **saw** being watered is the pot
      holding the sensor the software named. Tick only those.
- [ ] Treat anything marked low confidence, cross-talk, several sensors
      responded, or claimed by two valves as a plumbing problem to fix, not a
      mapping to accept.
- [ ] An unresolved valve (no response) means: check the hose, the emitter, and
      whether it waters a pot outside the selection.
- [ ] Approve both sides of a swap together. The portal refuses half a swap.
- [ ] Apply only in a maintenance window: applying stops the controller,
      removes and recreates the changed pairings, and restarts it.
- [ ] After applying, wait for "Verified by controller readback", then re-check
      the Pairings table and the calibration on each changed pot.

## 6. Rollback

- Before applying: nothing to roll back. Runs only ever propose.
- After applying: use "roll back to the previous topology" (offered once
  readback is verified). It queues the exact inverse through the same reviewed
  path. The previous topology is also in the downloaded run log and your CSV.
- Restore watering: "restore recorded settings" returns the prepared pots to
  their recorded targets, pulse lengths, and intervals. Confirm in the Pairings
  table that targets are back before leaving the bench.
- If a settings batch fails part-way, the executor quarantines the device. Keep
  the controller stopped, verify valves closed, reconcile per the executor
  README, then re-create pairings from the CSV if needed.

## 7. Record afterwards

- Downloaded run logs (rehearsal and real), the pairing CSV from before and
  after, and the bench notes of which pot each valve actually watered.
- Every discrepancy between what you saw and what the software proposed. Those
  are what decide whether the thresholds (0.5% VWC rise, 3 readings, 60 s
  settle) are right for this soil and these emitters.

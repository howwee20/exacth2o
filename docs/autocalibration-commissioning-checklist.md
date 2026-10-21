# Autocalibrate and hold-to-water: supervised hardware acceptance

Software tests, the simulated 100-pot preview and the deployment prove the code
path, not the bench. Treat every result as unvalidated until it is confirmed by eye.
Two people: one at the bench with a hand on the water shutoff, one at the portal.
Never submit a hardware operation as a cosmetic smoke test.

## 0. Gates the platform owner opens first

Both features use gates that are closed by default and are **not** opened by this
release. Open them one at a time, with a reviewed change each, after the bench
checks in section 1.

Controller (Balena device variables, `cron_svc`, `health_svc`, `valve_watchdog`):

- [ ] The running release contains `ValveArbiter`, the renewable `ManualHoldManager`,
      the timed-pulse endpoint and the `valve_watchdog` service (`balena push`; confirm
      every expected service is running, including `valve_watchdog`).
- [ ] `EXACTH2O_MANUAL_HOLD_SECRET` is the same value on `cron_svc`, `health_svc` and the
      `manual-hold` Edge Function; `EXACTH2O_CONTROLLER_COMMAND_SECRET` is set for
      `cron_svc` and `valve_watchdog`.
- [ ] `EXACTH2O_MANUAL_HOLD_ENABLED=1` only after section 1 passes.
- [ ] `EXACTH2O_VALVE_MAX_CONTINUOUS_ON_MS` set only from the solenoid or supply
      datasheet (leave unset otherwise; the portal then says no limit is configured).
- [ ] Lease timing left at `MANUAL_HOLD_LEASE_MS=2500` (renewals every 0.5 s) unless
      the bench timing in section 1 says otherwise.

Command path (unchanged gates, also used by Autocalibrate's pulses and settings):

- [ ] Executor live: `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN=0`, fresh heartbeat, and
      `EXACTH2O_MANUAL_WATER_ENABLED=1` (separate reviewed change).
- [ ] Edge Function secrets: `CONTROL_COMMAND_INTAKE_ENABLED=1`,
      `MANUAL_WATER_INTAKE_ENABLED=1`; command queue empty; device not quarantined.
- [ ] Database migration `20261021160000_full_scale_autocalibration_and_manual_hold`
      applied (after `supabase db push --dry-run` review), and the `manual-hold` and
      `create-control-command` functions deployed from this commit.

If any gate is closed, the hold or the first pulse is refused, nothing is watered,
and the portal says why. That is the expected fail-closed result.

## 1. Bench checks before any researcher uses either feature

Hold-to-water, on one solenoid, outlet into a catch cup:

- [ ] Hold in the portal (desktop) for 5 s, release: water starts after "Controller:
      open", stops on release; the panel shows "Controller: closed" and a measured
      release-to-close time. Note the time from release to the water stopping.
- [ ] Hold for **60 s** (past the old 15-second cap): water flows the whole time,
      elapsed time counts up, nothing stops it early.
- [ ] Hold, then pull the network cable of the computer (or turn on airplane mode on
      the phone): the valve closes on its own within about 2.5 s (the lease), with no
      connection. The portal shows "Unconfirmed" until it reconnects.
- [ ] Hold, then stop `cron_svc` (`balena` dashboard, restart the service): within
      about 2 s after the owner's deadline the watchdog drives the relay boards'
      RESET low and **every** relay drops. Confirm with the outlet and a meter on
      GPIO 16 (RESET). The watchdog stays tripped until acknowledged and reconciled.
- [ ] On a phone (a real one, not emulation): press and hold, a second finger does not
      start or end anything, lifting the first finger stops the water.
- [ ] Two operators: the second sees "In use by …"; ticking "Take over" closes the
      first hold before the second opens (watch the outlets).
- [ ] With automatic watering due on a pot, hold a different solenoid: the automatic
      pulse waits (the hold has priority) and the pot is watered after the settle
      time, not during the hold.
- [ ] Every one of the 100 solenoids reached once by number from "Manual water → By
      solenoid", and the printed label recorded where it was not yet confirmed.

## 2. Autocalibrate: supervised run

Physical prechecks:

- [ ] Every emitter is in a pot or a catch cup; no open hose ends; shutoff reachable.
- [ ] Pots are not freshly watered or saturated (below about 40% VWC).
- [ ] Download "Pairings CSV" and photograph the bench labels before starting.

In the portal (Settings → Autocalibrate, researcher or administrator):

1. Select pots on the overhead view: a zone, or **Select all 100**. Pots that cannot
   take part are hatched with the reason; fix or leave them. Mark pots whose wiring
   you have confirmed at the bench as known-correct references (positive controls).
2. Continue: the server records each pot's settings. Queue the preparation change
   (watering off, every 60 s) and wait for "Confirmed by controller readback".
3. Wait a few minutes for 60 s readings, then run the safety checks. Run a
   **rehearsal** first (no valve command), then switch to **Open real valves**,
   check again, type the confirmation phrase and start. A first real run on one
   zone (25 pots) before all 100 is sensible.
4. Stay reachable. The floating bar shows progress and Stop on every page; closing
   the tab stops the run before its next pulse.

What correct evidence looks like, for each valve, never two at once:

- Exactly one emitter runs for about 3 s and stops on its own. **Note which pot.**
- A few minutes later one sensor rises and stays up; the others stay flat.
- At the end: matches, swaps and cycles, unresolved valves with a reason. Nothing on
  the controller has changed yet.

Abort criteria: press **Stop** (bar or page), then close the shutoff if water flows.
An emitter runs longer than the pulse plus 2 s; two run at once; water where it
should not be; the controller goes offline; a sensor jumps more than about 6% VWC.

## 3. Before applying any change

- [ ] Every reference pot came out on its recorded valve (otherwise treat the run as
      suspect; the portal holds back changes that involve a reference).
- [ ] For each swap or cycle you approve, the pot you saw watered is the pot the
      portal names. Groups apply whole or not at all; broken chains never apply.
- [ ] Apply in a maintenance window: one controller transaction moves every approved
      pot; wait for "Controller-verified".
- [ ] Rollback is offered once verified and is one command the same way.

## 4. Delivery confirmation and restore

- [ ] Open each changed valve by hand (pot details → "Open this valve by hand", or
      Manual water → By solenoid) and watch the water reach the pot; record it under
      "Confirm delivery at the bench".
- [ ] Restore: every pot returns to its own recorded target, pulse length and
      interval. Pots with an unresolved valve or an unapplied change stay sensing-only
      and are listed; confirm in Pairings before leaving.

## 5. Record afterwards

Download the session record (selection, original settings, evidence, approvals,
batches and readbacks), the before/after Pairings CSV, and bench notes of which pot
each valve actually watered. Every discrepancy between what you saw and what the
software proposed decides whether the thresholds (0.5% VWC rise, 3 readings, 60 s
settle) suit this soil and these emitters.

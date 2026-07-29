# ExactH2O production operations

## Researcher request lifecycle

Every supported write follows one traceable path:

1. The assistant resolves the project, role, live inventory, and capability.
2. It returns a complete specification without changing the system.
3. The researcher reviews and approves the specification.
4. The backend creates one `platform_operations` record and links every
   experiment, schedule, monitor, batch, and controller command to it.
5. Database triggers follow command state from queued through completion or
   failure.
6. Delivery evidence can verify or contradict the commanded outcome.
7. The portal shows the resulting timeline and notifications.

Read-only questions do not create control commands. Manual watering and sensor
initialization remain disabled in the shared capability contract.

## Canonical identity

The reconciliation chain is:

`organization → project → site → position → pot → experiment assignment → hardware binding → sensor + valve`

Experiment assignments preserve the sensor, valve, calibration, treatment,
target, and measurement configuration used by that revision. Hardware
bindings separately describe the current physical claim. A binding remains
`software_only` until it has independent physical confirmation.

## Installation configuration

Application code contains no production project or device identity. Configure
each deployment with Edge Function secrets:

```text
PUBLIC_INTAKE_PROJECT_ID
HEALTH_SYNC_PROJECT_ID
HEALTH_SYNC_ORGANIZATION_ID
HEALTH_SYNC_DEVICE_ID
HEALTH_SYNC_DEVICE_NAME
OWNER_HEALTH_BASE_URL          # optional; derived from device ID by default
OWNER_HEALTH_USER              # legacy MATT_OWNER_HEALTH_USER remains supported
OWNER_HEALTH_PASSWORD          # legacy MATT_OWNER_HEALTH_PASSWORD remains supported
```

Notification email delivery additionally requires:

```text
RESEND_API_KEY
NOTIFICATION_FROM_EMAIL
NOTIFICATION_DISPATCHER_SECRET
```

Without the notification provider values, the dispatcher fails closed. Portal
notifications remain the default preference; a user must explicitly enable
email delivery. An existing verified `QUOTE_EMAIL_FROM` is accepted when a
separate notification sender is not configured.

## Release sequence

1. Confirm the production branch and deployed portal source match.
2. Run the complete validation workflow, including the clean database restore
   and controller simulator.
3. Take a restorable production database backup.
4. Apply migrations without changing controller configuration.
5. Deploy Edge Functions and verify health/read-only assistant requests.
6. Publish the portal and verify its generated assets against the commit.
7. Reconcile operation records, command queue, current controller state, and
   notification outbox.

Do not test a production release by creating a watering command. Use the
simulator for full experiment/control tests.

### Controller self-service commissioning

Commission researcher-controlled experiments as a separate maintenance gate:

1. Deploy the additive executor-readiness migration and the experiment-builder
   guard. Until a fresh live-ready heartbeat exists, the portal must reject
   controller-affecting experiment creation before saving a tile.
2. Deploy the exact controller source with the executor still in dry-run and
   manual watering disabled. Verify release/source parity and the expected
   dry-run heartbeat.
3. Configure the shared owner-health readback secret on both sides without
   printing it, and verify that the executor remains healthy.
4. During an explicitly approved maintenance window, set the controller to
   `STOPPED`; read back `STOPPED`, confirm both pulse ledgers have no active
   pulse, and independently confirm every valve is closed.
5. Reconcile the command quarantine and prove the device credential with a
   non-mutating `export_data` command.
6. Enable the executor's live mode while keeping manual watering disabled.
   Require a fresh heartbeat with `dry_run=false`, `sync_ready=true`, and
   `local_api_reachable=true`.
7. Re-read controller configuration, confirm the command queue is empty, then
   explicitly resume `RUNNING`. Do not create a watering experiment merely as
   a production test.
8. Confirm that fresh `live-device` readings continue for the available
   controller-ready pairings and that the portal still blocks occupied pots.

The immediate rollback is to return the executor to dry-run and disable command
intake or the device token. If a command may have mutated the controller, keep
the controller stopped and use quarantine reconciliation; never resume from an
unknown outcome.

## Recovery

- Portal: redeploy the last known-good GitHub Pages commit.
- Edge Functions: redeploy the last known-good function source.
- Database: restore the verified backup into an isolated environment first;
  never improvise a destructive production rollback.
- Controller: stop command intake and the executor, inspect any leased or
  running command, independently verify every valve is closed, then use the
  existing quarantine/reconciliation workflow.

## Evidence boundary

The platform records requested intent, approval, commands, controller outcomes,
sensor observations, and any delivery evidence under one correlation chain.
Until a flow meter, scale, pressure sensor, reservoir measurement, or approved
manual observation writes `delivery_evidence`, the truthful result is
“commanded” or “observed,” not “physically delivered.”

## Remaining commissioning work

- Connect a physical delivery sensor and define tolerances for each irrigation
  path.
- Configure and schedule the notification dispatcher after verifying the
  sending domain and recipients.
- Populate and physically confirm canonical pot positions and hardware
  bindings for each installation.
- Keep Response Curve R&D isolated until immutable calibration, holdout
  evaluation, uncertainty, promotion, and rollback criteria are approved.

# ExactH2O control executor

`control_executor` is the missing controller-side consumer for the portal command queue:

`Portal Settings -> Supabase Edge Function -> project_control_commands -> control_executor -> local controller API`

It runs next to `api_svc` and `cron_svc` in the Balena release. It does not use a Supabase service-role key. It uses the public anon key plus a per-device token and calls four device-scoped RPCs:

- `device_claim_control_command(device_token, executor_version)`
- `device_renew_control_command_lease(device_token, command_id)`
- `device_complete_control_command(device_token, command_id, final_status, command_result, command_error)`
- `device_quarantine_control_command(device_token, command_id, quarantine_reason)`

The claim RPC only claims commands whose `device_id` exactly matches the token's device. Portal-created hardware commands must be device-addressed before they can execute.

## Safety defaults

- Dry-run is enabled by default with `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN=1`.
- Live manual watering has a second independent fail-closed gate, `EXACTH2O_MANUAL_WATER_ENABLED=0`. Turning off global dry-run does not enable researcher watering.
- Manual water is bounded by `EXACTH2O_MANUAL_WATER_MAX_SECONDS` and `EXACTH2O_MANUAL_WATER_MAX_VALVE_SECONDS`, then requires a controller-owned timed-pulse endpoint. The executor defaults to `POST /valves/pulse`; it never opens a valve unless that endpoint accepts the complete bounded pulse. Every request carries stable `commandId` and `pulseId` values that the controller must treat idempotently.
- The old process-owned `OPEN -> sleep -> CLOSE` path is not present in the production executor.
- Pairing edits, calibration create/apply/delete, group create/removal, and board config require the controller state to be `STOPPED`.
- Sensor initialization is locked both server-side and in the production executor. Any future maintenance implementation must be a separate reviewed protocol with a backup, admin approval, stopped-state proof, bench verification, and rollback plan.
- Local controller calls and Supabase RPC calls have abort timeouts. Running commands use a fail-closed database lease that the executor renews while working; an expired lease is not automatically replayed. A timed-out mutation is quarantined as an unknown outcome, disables that device's command tokens, and requires explicit state reconciliation before any later command.
- Successful runtime/config commands trigger `sync-owner-health`, and the executor is the primary periodic state-sync authority. The GitHub schedule remains a low-authority watchdog and is deduplicated when device sync is fresh.
- The Pi stores only `EXACTH2O_DEVICE_TOKEN`, never the Supabase service-role key.

## Required environment

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `EXACTH2O_DEVICE_TOKEN`
- `EXACTH2O_LOCAL_API_BASE`, default `http://api_svc:8888/v1`
- `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN`, default `1`
- `EXACTH2O_MANUAL_WATER_ENABLED`, default `0`; enable only after the timed-pulse bench protocol passes
- `EXACTH2O_CONTROL_EXECUTOR_POLL_MS`, default `5000`
- `EXACTH2O_LOCAL_API_TIMEOUT_MS`, default `10000`
- `EXACTH2O_SUPABASE_RPC_TIMEOUT_MS`, default `15000`
- `EXACTH2O_COMMAND_LEASE_RENEW_MS`, default `30000`
- `EXACTH2O_MANUAL_WATER_MAX_SECONDS`, default `60`
- `EXACTH2O_MANUAL_WATER_MAX_VALVE_SECONDS`, default `120`
- `EXACTH2O_MANUAL_WATER_PULSE_PATH`, default `/valves/pulse`
- `EXACTH2O_STATE_SYNC_MS`, default `120000`
- `EXACTH2O_STATE_SYNC_TIMEOUT_MS`, default `30000`
- `EXACTH2O_PROJECT_ID`, required whenever dry-run is disabled
- `EXACTH2O_DEVICE_ID`, required whenever dry-run is disabled
- `EXACTH2O_SYNC_OWNER_HEALTH_URL`, default `${SUPABASE_URL}/functions/v1/sync-owner-health`
- `SYNC_OWNER_HEALTH_SECRET` or `EXACTH2O_SYNC_OWNER_HEALTH_SECRET`, required whenever dry-run is disabled

## Token creation

Apply the control-command migrations through `supabase/migrations/20260709190000_optimize_control_and_portal_data.sql`, then create a token through reviewed service-role PostgREST/RPC automation. The function intentionally rejects a normal SQL-editor session without a service-role JWT claim:

```js
const { data: rawToken, error } = await serviceRoleClient.rpc(
  "create_device_control_token",
  {
    token_project_id: "<project_id>",
    token_device_id: "<device_id>",
    token_label: "balena-control-executor",
  },
);
if (error) throw error;
```

Store the returned raw token once as the Balena env var `EXACTH2O_DEVICE_TOKEN`.

## Balena wiring

Copy the service from `docker-compose.snippet.yml` into the exact current controller release compose file and set `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN=1` for the first release.

## Verification plan before live deploy

1. Confirm the exact current Balena source checkout and release ID.
2. Apply the migration in a staging Supabase project or maintenance window.
3. Create a device token for the target device and set it in Balena.
4. Deploy dry-run mode and queue one non-hardware command.
5. Confirm the command moves `queued -> running -> succeeded` with dry-run result details.
6. Queue an update that requires stopped state while the controller is running and confirm it fails safely.
7. Implement and independently test the controller-side timed-pulse/watchdog endpoint. It must atomically accept `{ address, relayAddress, durationMilliseconds, commandId, pulseId }`, durably deduplicate `pulseId` across API restarts, reject durations above its own hard limit, coordinate with or reject overlapping automatic/manual watering, and close the valve on its own deadline. Container termination or executor loss must not extend the pulse. Controller config-mutation endpoints must also enforce `STOPPED` atomically; the executor's GET-then-write preflight is not sufficient on its own.
8. Bench-test `manual_water` with a short duration, interrupt the executor and API containers mid-pulse, simulate controller/power loss, and physically confirm valve close at the controller-owned deadline or the relay's verified default-off state.
9. Only then consider `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN=0`; keep `EXACTH2O_MANUAL_WATER_ENABLED=0` until the timed-pulse interruption tests pass, then enable it as a separate reviewed change.

If a mutation times out or a command lease expires, command tokens stay disabled. After independently observing fresh controller state and confirming every valve is closed, a service-role maintenance process can record the evidence and explicitly re-enable only tokens disabled by command quarantine:

```js
await serviceRoleClient.rpc("reconcile_device_control_quarantine", {
  reconcile_project_id: "<project_id>",
  reconcile_device_id: "<device_id>",
  observed_at: new Date().toISOString(),
  confirmed_valves_closed: true,
  observed_state: {
    controller_state: "STOPPED",
    verification: "bench_or_physical",
  },
  reconciliation_note: "Operator verified controller state and all valves closed",
  reenable_commands: true,
});
```

Rollback is to remove/disable the `control_executor` service and revoke the token:

```sql
update public.device_control_tokens
set enabled = false, revoked_at = now()
where device_id = '<device_id>';
```

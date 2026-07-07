# ExactH2O control executor

`control_executor` is the missing controller-side consumer for the portal command queue:

`Portal Settings -> Supabase Edge Function -> project_control_commands -> control_executor -> local controller API`

It runs next to `api_svc` and `cron_svc` in the Balena release. It does not use a Supabase service-role key. It uses the public anon key plus a per-device token and calls two RPCs:

- `device_claim_control_command(device_token, executor_version)`
- `device_complete_control_command(device_token, command_id, final_status, command_result, command_error)`

The claim RPC only claims commands whose `device_id` exactly matches the token's device. Portal-created hardware commands must be device-addressed before they can execute.

## Safety defaults

- Dry-run is enabled by default with `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN=1`.
- Manual water is bounded by `EXACTH2O_MANUAL_WATER_MAX_SECONDS` and closes valves in a `finally` path.
- Pairing edits, calibration apply/delete, group removal, board config, and sensor initialization require the controller state to be `STOPPED`.
- `initialize_sensors` is blocked unless the command payload includes `allow_initialize_sensors: true`; this should remain admin-only and should require a backup.
- The Pi stores only `EXACTH2O_DEVICE_TOKEN`, never the Supabase service-role key.

## Required environment

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `EXACTH2O_DEVICE_TOKEN`
- `EXACTH2O_LOCAL_API_BASE`, default `http://api_svc:8888/v1`
- `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN`, default `1`
- `EXACTH2O_CONTROL_EXECUTOR_POLL_MS`, default `5000`
- `EXACTH2O_MANUAL_WATER_MAX_SECONDS`, default `60`

## Token creation

Apply `supabase/migrations/20260707170000_add_device_control_command_rpc.sql`, then create a token using the Supabase SQL editor or service-role automation:

```sql
select public.create_device_control_token(
  '<project_id>'::uuid,
  '<device_id>',
  'balena-control-executor'
);
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
7. Bench-test `manual_water` with a short duration and physically confirm valve close.
8. Only then consider `EXACTH2O_CONTROL_EXECUTOR_DRY_RUN=0`.

Rollback is to remove/disable the `control_executor` service and revoke the token:

```sql
update public.device_control_tokens
set enabled = false, revoked_at = now()
where device_id = '<device_id>';
```

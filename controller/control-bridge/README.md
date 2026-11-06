# exactH2O Control Bridge

This service runs on the Balena device network and turns authenticated portal control requests into local controller API calls.

The browser never receives the Supabase service-role key. The portal only queues commands in `project_control_commands`; this bridge claims those commands, calls the local API, and writes success/failure plus audit rows back to Supabase.

## Required environment

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CONTROL_BRIDGE_PROJECT_ID`
- `CONTROL_BRIDGE_DEVICE_ID`
- `CONTROL_BRIDGE_API_BASE`, usually `http://api_svc:8888/v1`

## Safety switches

- `CONTROL_BRIDGE_EXECUTE=false` by default. When false, commands are claimed and marked failed with a clear disabled message, but no device API writes are made.
- `CONTROL_BRIDGE_ALLOW_DESTRUCTIVE=false` by default. When false, board config, system state, and sensor initialization commands fail before hitting the controller.
- `CONTROL_BRIDGE_ACCEPT_UNSCOPED_COMMANDS=false` by default. When false, the bridge only processes commands for its exact `device_id`.
- `CONTROL_BRIDGE_FETCH_EXPORTS=false` by default. When false, export commands resolve the local export endpoint and write that result to the audit log without pulling a large gzip stream through the bridge.

To actually apply portal commands on the device, set:

```sh
CONTROL_BRIDGE_EXECUTE=true
```

Only set `CONTROL_BRIDGE_ALLOW_DESTRUCTIVE=true` when you intentionally want the portal to be able to change board config, start/stop the controller, or initialize sensors.

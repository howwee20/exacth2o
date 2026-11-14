# Four-pot commissioning runtime

The saved pairing is Sensor One → Pot 1/output 1, Sensor Two → Pot 2/output 2,
Sensor Three → Pot 3/output 3, Sensor Four → Pot 4/output 4. The sensor serials,
SDI-12 adapter and exact Pan calibration are in `sensors.json`.

`control.py` runs on the Pi host through `exacth2o-testbed-control.service`.
It uses the existing GPIO relay service's Unix socket and persistent state;
it never claims GPIO itself. The API's CRON_URL points to the private Docker
host address, `http://172.18.0.1:3001/v1`. The service exposes STOPPED automatic
control state, four configured outputs, authenticated 2–5 second pulses,
persistent pulse readback, and authenticated host/sensor health. The independent
GPIO timer closes each pulse even if HTTP disconnects. Replayed command IDs never
open a valve again. Uncertain prior outcomes require reconciliation.

The executor is configured with `EXACTH2O_ALLOWED_COMMAND_TYPES=manual_water`,
`EXACTH2O_CONTROL_EXECUTOR_DRY_RUN=0`, `EXACTH2O_MANUAL_WATER_ENABLED=1`, and
both manual duration/budget limits at 5 seconds. Its authenticated health URL is
`http://172.18.0.1:3001/v1/health`. Automatic watering remains disabled.

The sensor logger runs once per minute through the existing sensing service,
checks all four physical identities, persists observations, and writes atomic
collector status for health reporting. Valve events use a persistent outbound
queue and the same device-scoped ingestion token as sensing.

November 14 deployment verification used unit/contract checks, authenticated
read-only health/status requests, and portal inspection. No additional valve
pulse was performed: EJ reserved the phone watering test for Jake.

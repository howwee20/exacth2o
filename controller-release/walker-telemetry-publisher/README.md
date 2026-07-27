# Walker Pi 5 sensing-only observer

This service is the Walker system-admin observation source. It replaces the
Gate B database tailer after live verification proved that the completed
controller experiment had been `STOPPED` since July 15 and therefore no longer
created database readings.

## Fixed capability boundary

The observer can:

- check the existing cron service's in-memory state through `GET /v1/state`;
- when and only when that state is exactly `STOPPED`, request one SDI-12
  measurement through the fixed internal `GET /v1/sensors` route;
- map the two verified 48-sensor boards to the immutable 96-sensor catalog;
- apply the already-evidenced Walker calibration polynomial;
- append fixed-identity observations to the authenticated Supabase receiver;
- persist an idempotent cursor and exact pending outbox in its dedicated volume.

The observer has no database connection, controller token, Supabase
service-role key, browser endpoint, inbound port, hardware device, Linux
capability, target, schedule, pairing mutation, sensor initialization, board
configuration, or irrigation route. It runs non-root with a read-only root
filesystem and pauses before the next sensor request if Walker is not
`STOPPED`.

## Sampling and crash safety

The 96 positions are read as two boards in parallel, one sensor per board at a
time. A full scan takes approximately four minutes and starts every ten
minutes. Successful pairs are published immediately, so the graph begins
updating before a full scan finishes.

Before every append, the exact readings and next cursor are durably saved as a
pending outbox. If the process stops after receiver acknowledgement but before
the cursor save, it replays the identical event IDs and values instead of
remeasuring under an already-used ID.

The preserved archive boundary is source cursor `1518645`. The observer never
backfills the prior drought-for-harvest experiment into the rolling 72-hour
view.

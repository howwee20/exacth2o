# Walker Pi 5 telemetry publisher — Gate B staging patch

This package is staged evidence only. It has not been deployed to Walker or
Balena. The exact Walker source checkout is still unavailable, so the compose
snippet must not be treated as a deployable release until it is reconciled
against the source for release `3981239` / commit
`24165fb95a29664b3a2231cb58a3ad89`.

## Capability boundary

The process can:

- `SELECT` seven columns from the local MariaDB `readings` table.
- append fixed-identity telemetry to `receive-walker-telemetry`.
- persist one numeric cursor in its dedicated volume.

The process cannot:

- call the Walker API or cron service;
- reach a valve, command, target, schedule, pairing, calibration, or settings
  endpoint;
- write, update, or delete a local database row;
- read any local table other than `walkerlabs.readings`;
- use a Supabase service-role key or portal user token.

The container is unprivileged, drops every Linux capability, has a read-only
root filesystem, mounts no hardware devices, and joins only a private database
network plus its egress network.

## Tail bootstrap and archive separation

On its first approved start, the publisher reads `MAX(readings.id)` and saves
that value as its durable cursor before polling for newer IDs. The receiver
also records the bootstrap time as `accepted_after`. Therefore every
pre-existing drought-for-harvest row is skipped and cannot enter the rolling
live table. There is no historical backfill mode.

The current read-only source check found:

- local source tail: `1518645`;
- local readings: `1510239`;
- current sensor rows: `96`;
- newest local reading: `2026-07-15 17:53:00`.

Fresh graph data therefore requires both Gate B approval and genuinely new
local readings. The publisher cannot resume sensor acquisition.

## Required approval-gated deployment sequence

1. Recover and verify the exact source for the current Walker release.
2. Reverify device UUID, fleet, release, services, and controller state.
3. Deploy the Supabase receiver and provision its publisher-only secret.
4. Create `walker_telemetry` with only the SQL grant in
   `create-readonly-user.template.sql`; verify `SHOW GRANTS`.
5. Integrate the compose snippet without changing existing service definitions.
6. Build locally and inspect the resulting compose configuration.
7. Present the exact release diff and verification evidence to EJ.
8. Only after EJ explicitly approves that exact Gate B release, deploy it.
9. Verify tail bootstrap, zero archive rows in the live table, heartbeat,
   append idempotency, and absence of controller/valve traffic.

If the cursor volume is missing after initialization, the process stops on the
receiver’s initialization conflict. It does not guess a replacement cursor or
silently backfill.

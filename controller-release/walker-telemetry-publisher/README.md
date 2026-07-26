# Walker Pi 5 telemetry publisher — Gate B

This package is the additive Gate B publisher. It must be deployed only by
carrying the five immutable image records and five exact service definitions
from Walker release `3981239` / Balena commit
`24165fb95a29664b3a2231cb58a3ad89` into a new release, then adding
`walker_telemetry_publisher`. The pre-existing services must never be rebuilt
from a reconstructed checkout.

## Capability boundary

The process can:

- `SELECT` seven columns from the local MariaDB `readings` table.
- append fixed-identity telemetry to `receive-walker-telemetry`.
- persist one numeric cursor in its dedicated volume.

The process contains no code path to:

- call the Walker API or cron service;
- reach a valve, command, target, schedule, pairing, calibration, or settings
  endpoint;
- write, update, or delete a local database row;
- read any local table other than `walkerlabs.readings`;
- use a Supabase service-role key or portal user token.

The container is unprivileged, drops every Linux capability, has a read-only
root filesystem, mounts no hardware devices, exposes no port, and accepts no
inbound application request. Its source contains only fixed SQL `SELECT`
queries against `walkerlabs.readings` and a fixed HTTPS receiver URL. Database
and receiver credentials are injected as publisher-service-only Balena
environment variables and are not stored in the release composition.

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

1. Reverify the exact current release composition, image records, image
   locations, content hashes, and live container image IDs.
2. Prove the new release reuses those five immutable image records and exact
   service definitions instead of rebuilding any existing service.
3. Reverify device UUID, fleet, release, services, and controller state.
4. Deploy the Supabase receiver and provision its publisher-only secret.
5. Create `walker_telemetry` with only the SQL grant in
   `create-readonly-user.template.sql`; verify `SHOW GRANTS`.
6. Build the publisher as a one-service draft; never pin that build-only draft.
7. Assemble a six-service draft from the five retained images plus the new
   publisher image and verify the exact service/image diff.
8. Pin only the Walker device to the assembled draft.
9. Verify tail bootstrap, zero archive rows in the live table, heartbeat,
   append idempotency, and absence of controller/valve traffic.
10. Finalize only after live verification; roll back by pinning release
    `3981239`.

If the cursor volume is missing after initialization, the receiver accepts
reinitialization only when the fixed publisher identity and current source tail
match its acknowledged cursor. Otherwise the process stops on the receiver’s
initialization conflict. It does not guess a replacement cursor or silently
backfill.

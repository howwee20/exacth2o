# Automatic valve request ordering

Eligible automatic watering requests receive a Redis sequence number. That number
travels with the pairing's Bull transition job through capacity and recovery waits.
A later request cannot open ahead of an earlier waiting request. Ordinary sensor
and closing transitions continue to run on the existing single worker.

After successful automatic closure, the controller promotes the oldest delayed
valve request once the configured supply recovery period has elapsed. Manual
release, topology rewrite completion, and fault reconciliation also notify the
scheduler, while retaining their existing arbitration rules. A head that is no
longer eligible leaves the wait and lets its successor be considered.

Promotion only requests reevaluation. It never directly opens an output. The
normal fresh-reading, live-configuration, watering, pulse-budget, ownership, and
arbitration checks still apply. Failed closure retains ownership. Stop cancels the
wake timer before draining the worker.

`VALVE_RECOVERY_DELAY_MS` remains unchanged (default 30 seconds after closure).
`VALVE_CONFLICT_RETRY_DELAY_MS` remains a timed fallback (default 30 seconds) if a
notification is missed. With recovery set to zero, a successor becomes ready on
handoff without waiting for that fallback. Ready work still waits for the shared
transition worker; this is not a hard real-time deadline.

Redis retains the sequence and delayed jobs across worker reconnection. The
existing full controller start/reload deliberately clears transitions and rebuilds
pairings; it starts new requests from newly evaluated state rather than replaying
old watering demand. This design uses the controller's existing single transition
worker and ownership model, not a distributed valve lock across multiple workers.

## Verification

From this directory:

```sh
npm test -- --silent
npm run build
```

For the optional integration suite, start a disposable local Redis container on
an unused loopback port (example 56379), then run:

```sh
docker run --rm -d --name exacth2o-fifo-test-redis -p 127.0.0.1:56379:6379 redis:7-alpine
VALVE_QUEUE_TEST_REDIS_PORT=56379 npm test -- --silent
# Remove only the disposable instance created above.
docker stop exacth2o-fifo-test-redis
```

The integration suite uses database 15 and deletes its `state-transitions` queue.
Never point it at a controller Redis instance. Tests exercise software scheduling
and simulated relay outcomes, not physical pressure recovery or water delivery.

import assert from "node:assert/strict";
import test from "node:test";

import { acquireLeaseWithin, leaseWaitMs, postCommandLeaseWaitMs } from "./lease-policy.mjs";

function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += ms; } };
}

test("only a post-command readback waits for a busy lease", () => {
  assert.equal(leaseWaitMs("control_executor"), postCommandLeaseWaitMs);
  for (const source of ["control_executor_watchdog", "supabase_cron_watchdog", "github_actions_watchdog", "scheduled_watchdog", "manual_admin_sync"]) {
    assert.equal(leaseWaitMs(source), 0);
  }
  // The executor aborts its state sync after 30 s; waiting plus an ingest fits.
  assert.ok(postCommandLeaseWaitMs + 5_000 < 30_000);
});

test("a free lease is taken at once and a busy one is retried until it frees", async () => {
  const c = clock();
  let attempts = 0;
  const free = await acquireLeaseWithin(async () => { attempts += 1; return { data: true }; }, { waitMs: 20_000, ...c });
  assert.equal(free.data, true);
  assert.equal(attempts, 1);

  attempts = 0;
  const later = await acquireLeaseWithin(async () => ({ data: ++attempts >= 4 }), { waitMs: 20_000, ...c });
  assert.equal(later.data, true);
  assert.equal(attempts, 4);
});

test("a lease that stays busy ends the wait at the bound; errors stop at once", async () => {
  const c = clock();
  let attempts = 0;
  const busy = await acquireLeaseWithin(async () => { attempts += 1; return { data: false }; }, { waitMs: 20_000, ...c });
  assert.equal(busy.data, false);
  assert.equal(attempts, 21);
  assert.ok(c.now() <= 20_000);

  const noWait = clock();
  attempts = 0;
  await acquireLeaseWithin(async () => { attempts += 1; return { data: false }; }, { waitMs: 0, ...noWait });
  assert.equal(attempts, 1);

  const error = new Error("rpc failed");
  attempts = 0;
  const failed = await acquireLeaseWithin(async () => { attempts += 1; return { error }; }, { waitMs: 20_000, ...c });
  assert.equal(failed.error, error);
  assert.equal(attempts, 1);
});

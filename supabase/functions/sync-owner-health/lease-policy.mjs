// A controller command's post-command readback must read the controller
// itself. If another ingest holds the lease, wait for it rather than answering
// "deduplicated": the executor counts any 2xx as a completed readback, and the
// other ingest may have read the controller before the command changed it.
// The wait stays inside the executor's 30 s state-sync timeout.
export const postCommandLeaseWaitMs = 20_000;

export function leaseWaitMs(source) {
  return source === "control_executor" ? postCommandLeaseWaitMs : 0;
}

/**
 * @param {() => PromiseLike<{ data?: unknown, error?: unknown }>} acquire
 * @param {{ waitMs: number, intervalMs?: number, now?: () => number, sleep?: (ms: number) => Promise<unknown> }} options
 */
export async function acquireLeaseWithin(acquire, {
  waitMs,
  intervalMs = 1_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + Math.max(0, waitMs);
  let result = await acquire();
  while (!result.error && result.data !== true && now() + intervalMs <= deadline) {
    await sleep(intervalMs);
    result = await acquire();
  }
  return result;
}

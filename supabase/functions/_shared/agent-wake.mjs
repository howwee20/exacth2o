// Wake a held agent request when Postgres reports work for its device.
// Triggers send '<agent>:<device_id>' on exacth2o_agent_wake (see migration
// 20261021043151). A notification is only a hint: callers re-read the durable
// queue with expiry and revision filters, so a lost, duplicated or reordered
// notification can delay work but can never create, replay or reorder it.
// Any listener failure degrades to the previous bounded re-check behavior.
export const agentWakeChannel = "exacth2o_agent_wake";

export function agentWakeKey(agent, deviceId) {
  return `${agent}:${deviceId}`;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("wake listener timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * connect(onNotify, onLost) resolves to { close() } once LISTEN is active.
 * Returns null when no listener is available within timeoutMs.
 * @param {null | ((onNotify: (payload: string) => void, onLost: () => void) => Promise<{ close?: () => Promise<unknown> }>)} connect
 * @param {string} key
 * @param {{ timeoutMs?: number, log?: (error: unknown) => void }} [options]
 */
export async function openWakeListener(connect, key, { timeoutMs = 1500, log = () => {} } = {}) {
  if (typeof connect !== "function") return null;
  let latched = false;
  let lost = false;
  const waiters = new Set();
  const settleAll = (outcome) => {
    for (const waiter of [...waiters]) waiter(outcome);
  };
  const onNotify = (payload) => {
    if (payload !== key) return;
    latched = true;
    settleAll("wake");
  };
  // A dropped or re-established LISTEN may have missed a notification: wake so
  // the caller re-reads, then stop trusting this listener for the request.
  const onLost = () => {
    lost = true;
    settleAll("lost");
  };

  let connection;
  const pending = Promise.resolve().then(() => connect(onNotify, onLost));
  try {
    connection = await withTimeout(pending, timeoutMs);
  } catch (error) {
    // Close a connection that finished opening after we gave up on it.
    pending.then((late) => late?.close?.()).catch(() => {});
    log(error);
    return null;
  }

  let closed = false;
  return {
    get lost() {
      return lost;
    },
    /** Resolves "wake", "lost", "timeout" or "abort"; consumes a latched wake. */
    wait(ms, signal) {
      if (latched) {
        latched = false;
        return Promise.resolve("wake");
      }
      if (lost) return Promise.resolve("lost");
      if (signal?.aborted) return Promise.resolve("abort");
      return new Promise((resolve) => {
        let timer;
        const finish = (outcome) => {
          clearTimeout(timer);
          waiters.delete(finish);
          signal?.removeEventListener?.("abort", onAbort);
          if (outcome === "wake") latched = false;
          resolve(outcome);
        };
        const onAbort = () => finish("abort");
        waiters.add(finish);
        signal?.addEventListener?.("abort", onAbort, { once: true });
        timer = setTimeout(() => finish("timeout"), Math.max(0, ms));
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      settleAll("abort");
      try {
        await connection?.close?.();
      } catch (error) {
        log(error);
      }
    },
  };
}

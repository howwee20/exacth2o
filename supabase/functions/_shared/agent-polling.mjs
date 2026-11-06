// Hold authenticated idle agent requests open instead of starting new Edge
// invocations, and answer as soon as durable work or attention appears.
//
// Every response must reach the installed clients before their own timeouts,
// measured from the moment the handler starts (gateway routing and worker boot
// happen before that, so the budgets below keep a margin for them):
// - gas-mixer native bridge 2.1.2 and screen agent 1.0.1: urllib timeout=20 s
// - lighting bridge 2.1.0: HttpURLConnection read timeout 12 s; its portal
//   readiness window is 15 s, so a sync must also restart within that window.
// Queue reads always use a fresh timestamp, so a command that expires while a
// request is held is never returned. No credential, acknowledgement or
// actuator policy lives here.
export const agentPollBudget = Object.freeze({
  pythonResponseBudgetMs: 16000,
  javaResponseBudgetMs: 9000,
  // Someone is waiting: keep displayed controller state at least as fresh as
  // the 2026-10-20 server (lighting ~5 s, native mixer ~11 s per cycle).
  lightingAttendedHoldMs: 4000,
  nativeAttendedPollHoldMs: 8000,
  // During an open screen session the agent polls taps between frames.
  screenSessionHoldMs: 500,
  // Protocol 2 clients state their timeout; answer this long before it.
  syncHoldMaxMs: 25000,
  syncClientMarginMs: 5000,
  // Without a wake listener, keep the behavior deployed on 2026-10-20.
  fallbackQueryIntervalMs: 2000,
  lightingFallbackIdleMs: 5000,
  legacyIdleHoldMs: 12000,
  wakeConnectTimeoutMs: 1200,
  minimumHoldMs: 250,
});

const defaultNow = () => performance.now();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-read the queue until it returns rows, errors, the deadline passes or the
 * request is aborted. With a listener, a wake-up re-reads once and answers
 * even when the queue is still empty: every wake for this device means a
 * command, session or viewer changed, and the agent's next request sees it. A
 * lost listener, or none at all, re-reads every fallbackIntervalMs instead.
 */
/**
 * @template {{ data?: unknown[] | null, error?: unknown }} T
 * @param {() => Promise<T>} read
 * @param {{ deadline: number, listener?: any, signal?: any, now?: () => number, sleep?: (ms: number) => Promise<unknown>, fallbackIntervalMs?: number }} options
 * @returns {Promise<T>}
 */
export async function holdUntilWork(read, {
  deadline,
  listener = null,
  signal = { aborted: false },
  now = defaultNow,
  sleep = defaultSleep,
  fallbackIntervalMs = agentPollBudget.fallbackQueryIntervalMs,
} = {}) {
  let result = await read();
  while (!result.error && !(result.data?.length) && !signal?.aborted) {
    const remaining = deadline - now();
    if (remaining < agentPollBudget.minimumHoldMs) break;
    if (listener && !listener.lost) {
      const outcome = await listener.wait(remaining, signal);
      if (outcome === "timeout" || outcome === "abort") break;
      result = await read();
      if (outcome === "wake") break;
      continue;
    }
    await sleep(Math.min(fallbackIntervalMs, remaining));
    if (signal?.aborted) break;
    result = await read();
  }
  return result;
}

/**
 * Hold an already-answered request until something needs the agent. Returns
 * "unavailable" immediately without a listener, so the response is not held
 * when the agent could not be woken early.
 */
/**
 * @param {{ deadline: number, listener?: any, signal?: any, now?: () => number }} options
 * @returns {Promise<string>}
 */
export async function holdQuietly({
  deadline,
  listener = null,
  signal = { aborted: false },
  now = defaultNow,
} = {}) {
  if (!listener || listener.lost) return "unavailable";
  const remaining = deadline - now();
  if (remaining < agentPollBudget.minimumHoldMs) return "deadline";
  const outcome = await listener.wait(remaining, signal);
  return outcome === "timeout" ? "deadline" : outcome;
}

/** Protocol 2 hold: what the client asked for, inside its stated timeout. */
export function syncHoldMs(requestedMs, clientTimeoutMs) {
  const requested = Number(requestedMs);
  const timeout = Number(clientTimeoutMs);
  if (!Number.isFinite(requested) || !Number.isFinite(timeout)) return 0;
  const ceiling = Math.min(agentPollBudget.syncHoldMaxMs, timeout - agentPollBudget.syncClientMarginMs);
  return Math.max(0, Math.min(Math.floor(requested), ceiling));
}

export function isAttended(attentionUntil, nowMs = Date.now()) {
  const until = Date.parse(String(attentionUntil ?? ""));
  return Number.isFinite(until) && until > nowMs;
}

// Deployed 2026-10-20 behavior, kept for the no-listener fallback path.
/**
 * @template {{ data?: unknown[] | null, error?: unknown }} T
 * @param {() => Promise<T>} read
 * @param {{ holdMs?: number, signal?: any, now?: () => number, sleep?: (ms: number) => Promise<unknown> }} [options]
 * @returns {Promise<T>}
 */
export async function pollUntilCommands(read, {
  holdMs = 0,
  signal = { aborted: false },
  now = defaultNow,
  sleep = defaultSleep,
} = {}) {
  const deadline = now() + Math.max(0, Math.min(agentPollBudget.legacyIdleHoldMs, holdMs ?? 0));
  return holdUntilWork(read, { deadline, signal, now, sleep });
}

/**
 * @param {number} startedAt
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<unknown> }} [options]
 */
export async function paceLightingIdle(startedAt, {
  now = defaultNow,
  sleep = defaultSleep,
} = {}) {
  const remaining = agentPollBudget.lightingFallbackIdleMs - (now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}

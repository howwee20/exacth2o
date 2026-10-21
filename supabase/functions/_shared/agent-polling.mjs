// Keep an authenticated idle request open instead of repeatedly starting new
// Edge invocations. Existing agents have 20s read timeouts. Command queries use
// a fresh timestamp on EVERY read, so a command expiring during a wait is never
// returned. No credentials, acknowledgement, or actuator policy changes here.
export const agentPollBudget = Object.freeze({
  screenIdleMs: 12000,
  nativeIdleMs: 12000,
  lightingIdleMs: 5000,
  queryIntervalMs: 2000,
});

export async function pollUntilCommands(read, {
  holdMs = 0,
  signal = { aborted: false },
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  // Leave 8s of the Python clients' 20s timeout for authentication, queries,
  // and transport. Their 45s readiness windows tolerate this idle cadence.
  const deadline = now() + Math.max(0, Math.min(12000, holdMs ?? 0));
  let result = await read();
  while (!result.error && !(result.data?.length) && !signal?.aborted) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(agentPollBudget.queryIntervalMs, remaining));
    if (signal?.aborted) break;
    result = await read();
  }
  return result;
}

// The lighting protocol already combines state, heartbeat and command polling.
// Pace only an empty, successful sync. Its Java client's read timeout is 12s,
// and its heartbeat validity is 15s. Pending commands/acks never wait here.
export async function paceLightingIdle(startedAt, {
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const remaining = agentPollBudget.lightingIdleMs - (now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}

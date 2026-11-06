import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  agentPollBudget,
  holdQuietly,
  holdUntilWork,
  isAttended,
  paceLightingIdle,
  pollUntilCommands,
  syncHoldMs,
} from "./agent-polling.mjs";
import { splitExpiredCommands } from "./gas-mixer-native-policy.mjs";

function clock() {
  let time = 0;
  const waits = [];
  return { now: () => time, waits, advance: (ms) => { time += ms; }, sleep: async (ms) => { waits.push(ms); time += ms; } };
}

// A listener whose wait() consumes scripted outcomes and advances the clock.
function scriptedListener(c, outcomes) {
  return {
    lost: false,
    waits: [],
    async wait(ms) {
      this.waits.push(ms);
      const next = outcomes.shift() ?? { outcome: "timeout" };
      const elapsed = next.after ?? ms;
      c.advance(Math.min(elapsed, ms));
      if (next.outcome === "lost") this.lost = true;
      return elapsed >= ms && next.outcome !== "lost" ? "timeout" : next.outcome;
    },
  };
}

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("installed clients' own timeouts bound every held response", () => {
  // Read the shipped clients rather than restating their constants.
  const native = source("../../../controller-release/gas-mixer-native-bridge/native_bridge.py");
  const screen = source("../../../controller-release/gas-mixer-agent/agent.py");
  const lighting = source("../../../controller-release/lighting-bridge/src/com/exacth2o/lighting/LightingAgentV2.java");
  const nativeTimeoutMs = Number(native.match(/^REQUEST_TIMEOUT_SECONDS = (\d+)$/m)?.[1]) * 1000;
  const screenTimeoutMs = Number(screen.match(/urlopen\(request, timeout=(\d+)\)/)?.[1]) * 1000;
  const lightingReadTimeoutMs = Number(lighting.match(/setReadTimeout\((\d+)\)/)?.[1]);
  const lightingSleepMs = Number(lighting.match(/getProperty\("poll_ms"\), (\d+)L/)?.[1]);
  assert.ok(nativeTimeoutMs > 0 && screenTimeoutMs > 0 && lightingReadTimeoutMs > 0 && lightingSleepMs > 0);

  // Leave at least 3 s (Python) / 2.5 s (Java) for routing, worker boot and transfer.
  assert.ok(agentPollBudget.pythonResponseBudgetMs <= Math.min(nativeTimeoutMs, screenTimeoutMs) - 3000);
  assert.ok(agentPollBudget.javaResponseBudgetMs <= lightingReadTimeoutMs - 2500);
  // The lighting portal readiness window is 15 s; the next sync must start
  // well inside it even with a slow 1.5 s reconnect.
  const readinessWindowMs = Number(source("./lighting-native-policy.mjs").match(/<= (\d+)_(\d+);/)?.slice(1).join(""));
  assert.equal(readinessWindowMs, 15000);
  assert.ok(agentPollBudget.javaResponseBudgetMs + lightingSleepMs + 1500 < readinessWindowMs - 2000);
  // The native bridge also heartbeats inside this budget; the 45 s window holds
  // even when heartbeat, state and poll are each held to the full budget.
  assert.ok(2 * agentPollBudget.pythonResponseBudgetMs + 2000 + 1500 < 45000);
});

test("without a listener, an idle poll keeps the deployed 2 s re-read cadence", async () => {
  const c = clock(); let reads = 0;
  const result = await pollUntilCommands(async () => { reads++; return { data: [], error: null }; }, { ...c, holdMs: 7000 });
  assert.equal(c.now(), 7000); assert.equal(reads, 5); assert.deepEqual(result.data, []);
  const capped = clock();
  await pollUntilCommands(async () => ({ data: [] }), { ...capped, holdMs: 999999 });
  assert.equal(capped.now(), agentPollBudget.legacyIdleHoldMs);
});

test("queued work returns at once; errors return at once, even after waiting", async () => {
  const c = clock();
  const command = { id: "one" };
  const listener = scriptedListener(c, []);
  const result = await holdUntilWork(async () => ({ data: [command], error: null }), { deadline: 16000, listener, ...c });
  assert.deepEqual(result.data, [command]);
  assert.equal(listener.waits.length, 0);
  assert.equal(c.now(), 0);

  const error = new Error("unavailable");
  let reads = 0;
  const failed = await holdUntilWork(async () => (++reads === 2 ? { error } : { data: [] }),
    { deadline: 16000, listener: scriptedListener(c, [{ outcome: "wake", after: 300 }]), ...c });
  assert.equal(failed.error, error);
});

test("a wake re-reads the queue and answers, with or without new work", async () => {
  const c = clock(); let reads = 0;
  const command = { id: "two" };
  const listener = scriptedListener(c, [{ outcome: "wake", after: 1200 }]);
  const found = await holdUntilWork(async () => ({ data: ++reads === 2 ? [command] : [] }),
    { deadline: 16000, listener, ...c });
  assert.deepEqual(found.data, [command]);
  assert.equal(c.now(), 1200);

  // Attention or session wakes return an empty answer so the agent loops now.
  const quiet = clock();
  const empty = await holdUntilWork(async () => ({ data: [] }),
    { deadline: 16000, listener: scriptedListener(quiet, [{ outcome: "wake", after: 400 }]), ...quiet });
  assert.deepEqual(empty.data, []);
  assert.equal(quiet.now(), 400);
});

test("an idle hold ends at the deadline with one listener wait and no polling", async () => {
  const c = clock(); let reads = 0;
  const listener = scriptedListener(c, []);
  await holdUntilWork(async () => { reads++; return { data: [] }; }, { deadline: 16000, listener, ...c });
  assert.equal(c.now(), 16000);
  assert.equal(reads, 1);
  assert.deepEqual(listener.waits, [16000]);
  assert.deepEqual(c.waits, []);
});

test("a lost listener falls back to bounded re-reads until the deadline", async () => {
  const c = clock(); let reads = 0;
  const listener = scriptedListener(c, [{ outcome: "lost", after: 1000 }]);
  await holdUntilWork(async () => { reads++; return { data: [] }; }, { deadline: 7000, listener, ...c });
  assert.equal(c.now(), 7000);
  // Initial read, a re-read after the loss, then every 2 s.
  assert.equal(reads, 5);
  assert.deepEqual(c.waits, [2000, 2000, 2000]);
});

test("aborted requests stop waiting", async () => {
  const c = clock();
  const result = await holdUntilWork(async () => ({ data: [] }),
    { deadline: 16000, signal: { aborted: true }, listener: scriptedListener(c, []), ...c });
  assert.deepEqual(result.data, []);
  assert.equal(c.now(), 0);
});

test("quiet holds need a listener and end on wake, loss or deadline", async () => {
  const c = clock();
  assert.equal(await holdQuietly({ deadline: 16000, listener: null, ...c }), "unavailable");
  assert.equal(c.now(), 0);
  assert.equal(await holdQuietly({ deadline: 16000, listener: scriptedListener(c, [{ outcome: "wake", after: 50 }]), ...c }), "wake");
  assert.equal(c.now(), 50);
  assert.equal(await holdQuietly({ deadline: 16000, listener: scriptedListener(c, []), ...c }), "deadline");
  assert.equal(c.now(), 16000);
  const lost = scriptedListener(c, []); lost.lost = true;
  assert.equal(await holdQuietly({ deadline: 99999, listener: lost, ...c }), "unavailable");
  assert.equal(await holdQuietly({ deadline: c.now() + 10, listener: scriptedListener(c, []), ...c }), "deadline");
});

test("protocol 2 holds stay inside the client's stated timeout and the 25 s cap", () => {
  assert.equal(syncHoldMs(25000, 40000), 25000);
  assert.equal(syncHoldMs(60000, 40000), 25000);
  assert.equal(syncHoldMs(25000, 12000), 7000);
  assert.equal(syncHoldMs(25000, 4000), 0);
  assert.equal(syncHoldMs(undefined, 40000), 0);
  assert.equal(syncHoldMs(25000, undefined), 0);
  assert.equal(syncHoldMs(-5, 40000), 0);
});

test("attention is a future timestamp only", () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  assert.equal(isAttended("2026-10-21T00:00:30Z", now), true);
  assert.equal(isAttended("2026-10-20T23:59:59Z", now), false);
  assert.equal(isAttended(null, now), false);
  assert.equal(isAttended("garbage", now), false);
});

test("expired queue rows are separated from deliverable ones with millisecond safety", () => {
  const now = Date.parse("2026-10-21T00:00:10.000Z");
  const rows = [
    { id: "a", expires_at: "2026-10-21T00:00:09.999+00:00" },
    { id: "b", expires_at: "2026-10-21T00:00:10+00:00" },
    { id: "c", expires_at: "2026-10-21T00:00:10.00071+00:00" },
    { id: "d", expires_at: "2026-10-21T00:00:24.96004+00:00" },
    { id: "e", expires_at: null },
  ];
  const { deliverable, expired } = splitExpiredCommands(rows, now);
  assert.deepEqual(deliverable.map((row) => row.id), ["d"]);
  assert.deepEqual(expired.map((row) => row.id), ["a", "b", "c", "e"]);
});

test("lighting fallback pacing still counts processing time", async () => {
  const c = clock(); await c.sleep(2000); await paceLightingIdle(0, c);
  assert.equal(c.now(), agentPollBudget.lightingFallbackIdleMs);
  await c.sleep(9000); await paceLightingIdle(0, c);
  assert.equal(c.now(), agentPollBudget.lightingFallbackIdleMs + 9000);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pollUntilCommands, paceLightingIdle, agentPollBudget } from './agent-polling.mjs';

function clock() {
  let time = 0;
  const waits = [];
  return { now: () => time, waits, sleep: async ms => { waits.push(ms); time += ms; } };
}

test('idle poll is bounded and re-reads rather than returning a stale query', async () => {
  const c = clock(); let reads = 0;
  const result = await pollUntilCommands(async () => { reads++; return { data: [], error: null }; }, { ...c, holdMs: 7000 });
  assert.equal(c.now(), 7000); assert.equal(reads, 5); assert.deepEqual(result.data, []);
});
test('queued commands return immediately and commands arriving during wait return at the next check', async () => {
  const c = clock(); let reads = 0;
  const command = { id: 'one' };
  const result = await pollUntilCommands(async () => ({ data: ++reads === 3 ? [command] : [], error: null }), { ...c, holdMs: 7000 });
  assert.equal(c.now(), 4000); assert.deepEqual(result.data, [command]);
  const instant = clock();
  await pollUntilCommands(async () => ({ data: [command] }), { ...instant, holdMs: 7000 });
  assert.equal(instant.waits.length, 0);
});
test('query errors exit immediately, including errors after waiting', async () => {
  const c = clock(); const error = new Error('unavailable'); let reads = 0;
  const result = await pollUntilCommands(async () => ++reads === 2 ? { error } : { data: [] }, { ...c, holdMs: 7000 });
  assert.equal(result.error, error); assert.equal(c.now(), 2000);
});
test('active screen session disables idle hold; abort and oversized holds are bounded', async () => {
  const c = clock(); let reads = 0;
  await pollUntilCommands(async () => { reads++; return { data: [] }; }, { ...c, holdMs: 0 });
  assert.equal(reads, 1); assert.equal(c.now(), 0);
  await pollUntilCommands(async () => ({ data: [] }), { ...c, holdMs: 999999 });
  assert.equal(c.now(), 12000);
  const aborted = clock();
  await pollUntilCommands(async () => ({ data: [] }), { ...aborted, holdMs: 7000, signal: { aborted: true } });
  assert.equal(aborted.waits.length, 0);
});
test('lighting counts existing processing time toward its 5s budget', async () => {
  const c = clock(); await c.sleep(2000); await paceLightingIdle(0, c);
  assert.equal(c.now(), 5000);
  await c.sleep(9000); await paceLightingIdle(0, c);
  assert.equal(c.now(), 14000);
  assert.ok(agentPollBudget.lightingIdleMs + 1000 < 15000);
});

test('existing client idle loops fit a 31-day invocation budget even when every snapshot changes', () => {
  const seconds = 31 * 86400;
  const nativeSource = readFileSync(new URL('../../../controller-release/gas-mixer-native-bridge/native_bridge.py', import.meta.url), 'utf8');
  const lightingSource = readFileSync(new URL('../../../controller-release/lighting-bridge/src/com/exacth2o/lighting/LightingAgentV2.java', import.meta.url), 'utf8');
  const nativeWaitSeconds = Number(nativeSource.match(/^POLL_INTERVAL_SECONDS = (\d+)$/m)?.[1]);
  const nativeTimeoutSeconds = Number(nativeSource.match(/^REQUEST_TIMEOUT_SECONDS = (\d+)$/m)?.[1]);
  const lightingWaitSeconds = Number(lightingSource.match(/getProperty\("poll_ms"\), (\d+)L/)?.[1]) / 1000;
  assert.ok(nativeWaitSeconds > 0 && lightingWaitSeconds > 0, 'Read deployed-client polling defaults');
  // One installed screen agent and native bridge, plus one lighting bridge.
  // Count a poll, heartbeat AND changed frame/state every cycle (conservative).
  // Native Python waits 2s after each cycle; installed lighting waits 1s.
  const screen = 3 * seconds / (agentPollBudget.screenIdleMs / 1000);
  const native = 3 * seconds / (agentPollBudget.nativeIdleMs / 1000 + nativeWaitSeconds);
  const lighting = seconds / (agentPollBudget.lightingIdleMs / 1000 + lightingWaitSeconds);
  // Other functions observed <4,500/day. Reserve 5,000/day and another
  // 40,000/month for interactive sessions, commands, and acknowledgements.
  const total = screen + native + lighting + 31 * 5000 + 40000;
  assert.ok(total < 1900000, `Expected <1.9M of 2M included calls; got ${total}`);
  assert.ok(agentPollBudget.screenIdleMs <= 12000);
  assert.ok(agentPollBudget.nativeIdleMs <= 12000);
  assert.ok(agentPollBudget.nativeIdleMs / 1000 <= nativeTimeoutSeconds - 8);
});

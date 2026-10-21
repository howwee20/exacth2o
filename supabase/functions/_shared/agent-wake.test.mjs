import test from "node:test";
import assert from "node:assert/strict";
import { agentWakeChannel, agentWakeKey, openWakeListener } from "./agent-wake.mjs";

function fakeConnector() {
  const state = { notify: null, lost: null, closed: 0 };
  const connect = async (onNotify, onLost) => {
    state.notify = onNotify;
    state.lost = onLost;
    return { close: async () => { state.closed += 1; } };
  };
  return { state, connect };
}

test("channel and keys match the migration trigger payload format", () => {
  assert.equal(agentWakeChannel, "exacth2o_agent_wake");
  assert.equal(agentWakeKey("native", "gas-mixer:b827eb548a44"), "native:gas-mixer:b827eb548a44");
});

test("no connector, a failing connector or a slow connector degrades to no listener", async () => {
  assert.equal(await openWakeListener(null, "native:x"), null);
  const errors = [];
  assert.equal(await openWakeListener(async () => { throw new Error("refused"); }, "native:x", {
    log: (error) => errors.push(error.message),
  }), null);
  assert.deepEqual(errors, ["refused"]);

  // A connection that completes after the timeout is closed, not leaked.
  let closed = 0;
  let finish;
  const slow = () => new Promise((resolve) => { finish = () => resolve({ close: async () => { closed += 1; } }); });
  assert.equal(await openWakeListener(slow, "native:x", { timeoutMs: 5 }), null);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closed, 1);
});

test("only this device's key wakes, and a wake before waiting is not lost", async () => {
  const { state, connect } = fakeConnector();
  const listener = await openWakeListener(connect, "native:gas-mixer:b827eb548a44");
  state.notify("lighting:lighting:beagle");
  state.notify("native:gas-mixer:other");
  assert.equal(await listener.wait(5), "timeout");
  state.notify("native:gas-mixer:b827eb548a44");
  assert.equal(await listener.wait(1000), "wake");
  // Consumed: the next wait needs a new notification.
  assert.equal(await listener.wait(5), "timeout");
  const pending = listener.wait(1000);
  state.notify("native:gas-mixer:b827eb548a44");
  assert.equal(await pending, "wake");
  await listener.close();
  await listener.close();
  assert.equal(state.closed, 1);
});

test("a lost LISTEN connection wakes waiters and stays lost", async () => {
  const { state, connect } = fakeConnector();
  const listener = await openWakeListener(connect, "screen:x");
  const pending = listener.wait(1000);
  state.lost();
  assert.equal(await pending, "lost");
  assert.equal(listener.lost, true);
  assert.equal(await listener.wait(1000), "lost");
});

test("abort and close end a wait promptly", async () => {
  const { connect } = fakeConnector();
  const listener = await openWakeListener(connect, "screen:x");
  const controller = new AbortController();
  const aborted = listener.wait(10_000, controller.signal);
  controller.abort();
  assert.equal(await aborted, "abort");
  assert.equal(await listener.wait(10_000, controller.signal), "abort");
  const closing = listener.wait(10_000);
  await listener.close();
  assert.equal(await closing, "abort");
});

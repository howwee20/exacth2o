import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityForSessionMode,
  deviceIsReady,
  gasMixerSessionTtlSeconds,
  normalizeSessionMode,
  sessionExpiresAt,
} from "./session-policy.mjs";

test("session modes map to separate installation capabilities", () => {
  assert.equal(normalizeSessionMode(undefined), "view");
  assert.equal(capabilityForSessionMode("view"), "remote_view");
  assert.equal(capabilityForSessionMode("control"), "remote_control");
  assert.throws(() => normalizeSessionMode("admin"));
});

test("device readiness requires a fresh outbound heartbeat and local session", () => {
  const now = Date.parse("2026-08-31T18:00:00Z");
  assert.equal(
    deviceIsReady({
      connected: true,
      local_session_available: true,
      last_heartbeat_at: "2026-08-31T17:59:30Z",
    }, now),
    true,
  );
  assert.equal(
    deviceIsReady({
      connected: true,
      local_session_available: true,
      last_heartbeat_at: "2026-08-31T17:58:00Z",
    }, now),
    false,
  );
  assert.equal(
    deviceIsReady({
      connected: true,
      local_session_available: false,
      last_heartbeat_at: "2026-08-31T17:59:55Z",
    }, now),
    false,
  );
});

test("remote sessions are capped at five minutes", () => {
  const now = Date.parse("2026-08-31T18:00:00Z");
  assert.equal(gasMixerSessionTtlSeconds, 300);
  assert.equal(sessionExpiresAt(now), "2026-08-31T18:05:00.000Z");
});

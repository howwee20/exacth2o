import assert from "node:assert/strict";
import test from "node:test";

import { uptimeSecondsFromSources } from "./uptime-policy.mjs";

test("prefers the canonical uptime field", () => {
  assert.equal(uptimeSecondsFromSources({
    uptime_seconds: 120,
    current_uptime_seconds: 240,
  }), 120);
});

test("normalizes the owner-health current uptime field", () => {
  assert.equal(uptimeSecondsFromSources({ current_uptime_seconds: "1145520" }), 1_145_520);
  assert.equal(uptimeSecondsFromSources({}, {
    ownerStatus: { current_uptime_seconds: "1145520" },
  }), 1_145_520);
});

test("accepts supported nested uptime fields and rejects invalid values", () => {
  assert.equal(uptimeSecondsFromSources({ host: { uptime_seconds: 300 } }), 300);
  assert.equal(uptimeSecondsFromSources({ system: { uptime_seconds: 600 } }), 600);
  assert.equal(uptimeSecondsFromSources({ current_uptime_seconds: -1 }), null);
  assert.equal(uptimeSecondsFromSources({ current_uptime_seconds: "unknown" }), null);
});

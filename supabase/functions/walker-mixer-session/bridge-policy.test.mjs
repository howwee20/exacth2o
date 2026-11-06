import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bridgeEnabled, linkedIdentities } from "./bridge-policy.mjs";

test("the bridge is off unless explicitly enabled", () => {
  assert.equal(bridgeEnabled({}), false);
  assert.equal(bridgeEnabled(undefined), false);
  for (const value of ["", "false", "1", "TRUE", "yes", " true"]) {
    assert.equal(bridgeEnabled({ WALKER_MIXER_SESSION_ENABLED: value }), false, value);
  }
  assert.equal(bridgeEnabled({ WALKER_MIXER_SESSION_ENABLED: "true" }), true);
});

test("linked identities come only from a well-formed secret", () => {
  const userId = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(
    linkedIdentities(JSON.stringify({ " Operator@Example.EDU ": userId.toUpperCase() })),
    { "operator@example.edu": userId },
  );
  for (const raw of [undefined, null, "", "not json", "[]", "\"text\"", "42"]) {
    assert.deepEqual(linkedIdentities(raw), {}, String(raw));
  }
  assert.deepEqual(
    linkedIdentities(JSON.stringify({ "a@example.edu": "not-a-user-id", "b@example.edu": 7 })),
    {},
  );
});

test("the handler checks the switch before any outbound request and keeps no accounts in source", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const switchAt = source.indexOf("bridgeEnabled(");
  assert.ok(switchAt > 0, "index.ts must consult bridgeEnabled");
  assert.ok(switchAt < source.indexOf("fetch("), "the switch must run before contacting Walker Lab");
  assert.ok(switchAt < source.indexOf("generateLink("), "the switch must run before issuing a link");
  assert.doesNotMatch(source, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "no email addresses in source");
});

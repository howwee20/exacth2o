import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantIntentInstructions,
  normalizeAssistantIntent,
} from "./assistant-policy.mjs";

test("assistant router preserves supported intents and concise reasons", () => {
  assert.deepEqual(normalizeAssistantIntent({
    intent: "settings",
    reason: "Change the target on an existing experiment.",
  }), {
    intent: "settings",
    reason: "Change the target on an existing experiment.",
  });
});

test("assistant router sends scheduled watering through guarded settings", () => {
  assert.match(
    assistantIntentInstructions(),
    /Choose settings for future-time watering/,
  );
});

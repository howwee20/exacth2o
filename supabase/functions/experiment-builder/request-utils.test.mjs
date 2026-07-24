import assert from "node:assert/strict";
import test from "node:test";
import {
  clean,
  isUuid,
  openAiUsage,
  record,
  scheduleInputForNormalization,
  sha256,
} from "./request-utils.mjs";

test("request helpers bound and normalize untrusted values", async () => {
  assert.deepEqual(record(null), {});
  assert.deepEqual(record(["not", "a", "record"]), {});
  assert.equal(clean("  abcdef  ", 3), "abc");
  assert.equal(isUuid("6f0e9ab6-b42b-4e8c-bf0c-21749616a2fc"), true);
  assert.equal(isUuid("not-a-project"), false);
  assert.deepEqual(openAiUsage({ input_tokens: 10, output_tokens: 4 }), {
    input_tokens: 10,
    output_tokens: 4,
  });
  assert.equal(
    await sha256("same-input"),
    await sha256("same-input"),
  );
});

test("schedule normalization serializes reviewed command payloads", () => {
  const normalized = scheduleInputForNormalization({
    settings_plan: {
      commands: [{
        command_type: "update_system_state",
        payload: { pause_watering: true },
        effect: "Pause watering",
      }],
    },
  });
  assert.deepEqual(normalized.settings_plan.commands, [{
    command_type: "update_system_state",
    payload_json: "{\"pause_watering\":true}",
    effect: "Pause watering",
  }]);
});

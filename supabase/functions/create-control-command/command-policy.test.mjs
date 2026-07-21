import assert from "node:assert/strict";
import test from "node:test";

import {
  adminOnlyCommandTypes,
  commandAccessDecision,
  controlCommandIntakeEnabled,
  disabledCommandTypes,
  manualWaterIntakeEnabled,
  researcherCommandTypes,
} from "./command-policy.mjs";
import {
  observationOnlyCommandDecision,
  observationOnlyPairingNames,
} from "./observation-policy.mjs";

test("control command intake is a strict fail-closed production gate", () => {
  assert.equal(controlCommandIntakeEnabled("1"), true);
  for (const value of [undefined, null, "", "0", "true", "yes", "TRUE"]) {
    assert.equal(controlCommandIntakeEnabled(value), false, String(value));
  }
});

test("manual watering has an independent strict safety gate", () => {
  assert.equal(manualWaterIntakeEnabled("1"), true);
  for (const value of [undefined, null, "", "0", "true", "yes"]) {
    assert.equal(manualWaterIntakeEnabled(value), false, String(value));
  }
});

test("researchers retain the explicitly supported experiment workflows", () => {
  for (const commandType of researcherCommandTypes) {
    assert.equal(commandAccessDecision("researcher", commandType).allowed, true, commandType);
  }
});

test("researchers cannot submit infrastructure-level commands", () => {
  for (const commandType of adminOnlyCommandTypes) {
    const decision = commandAccessDecision("researcher", commandType);
    assert.equal(decision.allowed, false, commandType);
    assert.equal(decision.status, 403, commandType);
  }
});

test("admins can submit admin and researcher commands", () => {
  for (const commandType of [...researcherCommandTypes, ...adminOnlyCommandTypes]) {
    assert.equal(commandAccessDecision("admin", commandType).allowed, true, commandType);
  }
});

test("sensor initialization remains locked for every portal role", () => {
  for (const commandType of disabledCommandTypes) {
    for (const role of ["admin", "researcher"]) {
      const decision = commandAccessDecision(role, commandType);
      assert.equal(decision.allowed, false);
      assert.equal(decision.status, 409);
      assert.match(decision.error ?? "", /locked/i);
    }
  }
});

test("viewers cannot submit any controller command", () => {
  for (const commandType of [...researcherCommandTypes, ...adminOnlyCommandTypes]) {
    const decision = commandAccessDecision("viewer", commandType);
    assert.equal(decision.allowed, false, commandType);
    assert.equal(decision.status, 403, commandType);
  }
});

test("unknown and missing roles fail closed", () => {
  assert.equal(commandAccessDecision("researcher", "unknown").allowed, false);
  assert.equal(commandAccessDecision(null, "manual_water").allowed, false);
});

test("all 39 observation-only pairings are protected from watering and settings", () => {
  assert.equal(observationOnlyPairingNames.size, 39);
  for (const pairingName of observationOnlyPairingNames) {
    for (const commandType of ["update_pairing", "manual_water", "apply_calibration"]) {
      const payload = commandType === "update_pairing"
        ? { pairing_name: pairingName }
        : { pairing_names: [pairingName] };
      const decision = observationOnlyCommandDecision(commandType, payload);
      assert.equal(decision.allowed, false, `${commandType}:${pairingName}`);
      assert.equal(decision.status, 409);
    }
  }
});

test("original Matt pairing controls remain available", () => {
  assert.equal(
    observationOnlyCommandDecision("manual_water", { pairing_names: ["Zone2-Pot41"] }).allowed,
    true,
  );
});

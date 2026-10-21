import assert from "node:assert/strict";
import test from "node:test";

import { validateRemapPayload, validateRestorePayload } from "./topology-policy.mjs";

const sensor = (index) => `D30GQN2${index < 50 ? "D" : "E"}:${"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[index % 50]}`;
const valve = (index) => `${["0x24", "0x20", "0x26"][Math.floor(index / 48)]}:${(index % 48) + 1}`;
const cycle = (count = 100) => Array.from({ length: count }, (_, index) => ({
  pairing_name: `Zone${Math.floor(index / 25) + 1}-Pot${index + 1}`,
  sensor_key: sensor(index),
  from_valve_key: valve(index),
  to_valve_key: valve((index + 1) % count),
}));

test("a complete 100-pot cycle is one valid remap", () => {
  const result = validateRemapPayload({ remap_id: "hw-20261021-abc", changes: cycle() });
  assert.equal(result.changes.length, 100);
});

test("a cross-zone swap and prefixed research names are valid", () => {
  const result = validateRemapPayload({ remap_id: "r", changes: [
    { pairing_name: "Huiqiao-Zone3-Pot68", sensor_key: "D30GQN2E:R", from_valve_key: "0x20:20", to_valve_key: "0x24:3" },
    { pairing_name: "Zone1-Pot3", sensor_key: "D30GQN2D:c", from_valve_key: "0x24:3", to_valve_key: "0x20:20" },
  ] });
  assert.equal(result.changes.length, 2);
});

test("a remap that orphans or doubles a valve is refused", () => {
  assert.throws(() => validateRemapPayload({ remap_id: "r", changes: cycle().slice(0, 99) }), /complete swap or cycle/);
  const doubled = cycle(3);
  doubled[2] = { ...doubled[2], to_valve_key: doubled[0].to_valve_key };
  assert.throws(() => validateRemapPayload({ remap_id: "r", changes: doubled }), /received twice/);
});

test("remap limits and identities are enforced", () => {
  assert.throws(() => validateRemapPayload({ remap_id: "r", changes: cycle(201) }), /1-200|too large/);
  assert.throws(() => validateRemapPayload({ changes: cycle(2) }), /remap ID/);
  assert.throws(() => validateRemapPayload({ remap_id: "r", changes: [{ ...cycle(2)[0], to_valve_key: cycle(2)[0].from_valve_key }] }), /already uses/);
  assert.throws(() => validateRemapPayload({ remap_id: "r", changes: [{ ...cycle(2)[0], pairing_name: "drop table" }] }), /pairing name/);
  // Case-distinct SDI-12 sensors are different sensors, not duplicates.
  const caseDistinct = cycle(2).map((change, index) => ({ ...change, sensor_key: index ? "D30GQN2D:P" : "D30GQN2D:p" }));
  assert.equal(validateRemapPayload({ remap_id: "r", changes: caseDistinct }).changes.length, 2);
});

test("restore accepts 100 distinct exact settings and rejects out-of-range values", () => {
  const pairings = Array.from({ length: 100 }, (_, index) => ({
    pairing_name: `Zone${Math.floor(index / 25) + 1}-Pot${index + 1}`, sensor_key: sensor(index), valve_key: valve(index),
    target_vwc: index % 9 === 0 ? null : 10 + (index % 60), valve_open_time_ms: index % 11 === 0 ? 0 : 1500 + index, measurement_interval_ms: 60_000 + index * 1000,
  }));
  assert.equal(validateRestorePayload({ pairings }).pairings.length, 100);
  assert.throws(() => validateRestorePayload({ pairings: [{ ...pairings[1], target_vwc: 101 }] }), /0-100/);
  assert.throws(() => validateRestorePayload({ pairings: [{ ...pairings[1], valve_open_time_ms: 2.5 }] }), /pulse length/);
  assert.throws(() => validateRestorePayload({ pairings: [pairings[1], pairings[1]] }), /more than once/);
});

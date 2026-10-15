import assert from "node:assert/strict";
import test from "node:test";

import { holdExpiry, LEASE_MS, pairingPot, potForPairing, resolvePots, RECEIPT_LEASE_MS } from "./hold-policy.mjs";

const pairing = (name, relay, channel, sensor = "E:R") => ({ name, sensorId: 600, valveId: 1600, Valve: { relayAddress: relay, address: String(channel) },
  Sensor: { boardSerialId: `D30GQN2${sensor[0]}`, address: sensor.slice(2) } });
// Live pairings whose names differ from the physical pot their valve waters.
const live = [
  pairing("Zone3-Pot16", "0x20", 18, "E:P"),
  pairing("Zone3-Pot66", "0x24", 16, "D:P"),
  pairing("Zone4-Pot100", "0x20", 43, "E:2"),
];
const route = (pot, status, relay, channel, source = "field_record_2026-06-15") => ({ pot_number: pot, status, relay_address: relay, channel, source, evidence: "", updated_at: "" });
const routes = [
  route(1, "confirmed", 36, 1), route(16, "confirmed", 36, 16), route(48, "confirmed", 36, 48), route(49, "confirmed", 32, 1),
  route(66, "confirmed", 32, 18), route(76, "needs_confirmation", null, null), route(77, "needs_confirmation", 32, 30),
  route(86, "no_water_line", null, null), route(100, "confirmed", 32, 43, "field_record_2026-06-16"),
];
const boards = [32, 36, 38];
const byPot = (pots) => new Map(pots.map((entry) => [entry.pot, entry]));

test("every pot 1-100 is listed; only confirmed routes are ready", () => {
  const pots = resolvePots(routes, boards, live);
  assert.equal(pots.length, 100);
  assert.deepEqual(pots.filter((entry) => entry.status === "ready").map((entry) => entry.pot), [1, 16, 48, 49, 66, 100]);
  const map = byPot(pots);
  assert.equal(map.get(2).status, "unmapped");
  assert.equal(map.get(76).status, "needs_confirmation");
  assert.equal(map.get(76).candidate, null);
  assert.deepEqual(map.get(77).candidate, { relayAddress: 32, channel: 30 });
  assert.equal(map.get(86).status, "no_water_line");
});

test("physical pots water by their recorded valve, never by pairing names", () => {
  const map = byPot(resolvePots(routes, boards, live));
  // Pot 16's valve is 0x24:16, whose pairing is named Zone3-Pot66 — and the reverse.
  assert.deepEqual([map.get(16).relayAddress, map.get(16).channel, map.get(16).pairing.name, map.get(16).pairing.namedPot], [36, 16, "Zone3-Pot66", 66]);
  assert.deepEqual([map.get(66).relayAddress, map.get(66).channel, map.get(66).pairing.name], [32, 18, "Zone3-Pot16"]);
  assert.equal(map.get(66).pairing.sensorKey, "D30GQN2E:P");
  assert.equal(map.get(1).pairing, null);
});

test("board boundaries: pot 48 ends 0x24 and pot 49 starts 0x20", () => {
  const map = byPot(resolvePots(routes, boards, live));
  assert.deepEqual([map.get(48).relayAddress, map.get(48).channel], [36, 48]);
  assert.deepEqual([map.get(49).relayAddress, map.get(49).channel], [32, 1]);
});

test("a shared valve or an unconfigured board blocks the pot", () => {
  const map = byPot(resolvePots([...routes, route(2, "confirmed", 36, 1), route(3, "confirmed", 38, 3)], [32, 36], live));
  assert.equal(map.get(1).status, "conflict");
  assert.match(map.get(2).reason, /0x24:1 is also confirmed for pot 1/);
  assert.match(map.get(3).reason, /0x26 is not configured/);
});

test("two pairings on one valve are reported, and neither is used for the controller check", () => {
  const map = byPot(resolvePots(routes, boards, [...live, pairing("Zone1-Pot99", "0x24", 1)]));
  const map2 = byPot(resolvePots(routes, boards, [...live, pairing("Zone1-Pot99", "0x24", 1), pairing("Zone1-Pot98", "0x24", 1)]));
  assert.equal(map.get(1).pairing.name, "Zone1-Pot99");
  assert.equal(map2.get(1).pairing, null);
  assert.deepEqual(map2.get(1).sharedPairings, ["Zone1-Pot99", "Zone1-Pot98"]);
});

test("a pairing name from an older portal maps to the pot its valve waters", () => {
  const pots = resolvePots(routes, boards, live);
  assert.equal(potForPairing(pots, live, "Zone3-Pot16"), 66);
  assert.equal(potForPairing(pots, live, "Zone3-Pot66"), 16);
  assert.equal(potForPairing(pots, live, "Zone9-Pot1"), null);
});

test("only exact Zone-Pot names carry a research pot number", () => {
  assert.equal(pairingPot("Zone3-Pot18"), 18);
  assert.equal(pairingPot("621-1563"), null);
  assert.equal(pairingPot("Zone3-Pot18 copy"), null);
});

test("presses are bounded by both press time and server receipt", () => {
  const now = 1_000_000;
  assert.equal(holdExpiry(now, now), now + RECEIPT_LEASE_MS);
  assert.equal(holdExpiry(now - 1500, now), now - 1500 + LEASE_MS);
  assert.equal(holdExpiry(now - 2001, now), null);
  assert.equal(holdExpiry(now + 1001, now), null);
  assert.equal(holdExpiry(Number.NaN, now), null);
});

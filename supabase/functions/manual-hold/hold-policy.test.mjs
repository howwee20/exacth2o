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

test('candidate test is admin-only, recorded, conflict checked, and does not confirm the record', async () => {
  const { candidateTestRoute } = await import('./hold-policy.mjs');
  const pot = { pot: 74, status: 'needs_confirmation', candidate: { relayAddress: 32, channel: 26 } };
  const before = JSON.stringify(pot);
  assert.equal(candidateTestRoute(pot, [pot], [32], 'researcher'), null);
  assert.equal(candidateTestRoute(pot, [pot], [], 'admin'), null);
  assert.equal(candidateTestRoute({ ...pot, candidate: null }, [pot], [32], 'admin'), null);
  assert.equal(candidateTestRoute(pot, [pot, { pot: 75, status: 'ready', relayAddress: 32, channel: 26 }], [32], 'admin'), null);
  assert.equal(candidateTestRoute(pot, [pot], [32], 'admin').channel, 26);
  assert.equal(JSON.stringify(pot), before);
});

test('a sole enabled pairing identifies a shared valve without changing legacy observations', () => {
 const active={...pairing('Huiqiao-Zone3-Pot68',32,20),WTCPercentLimit:35,ValveOpenTime:4000};
 const old={...pairing('Zone3-Pot68',32,20,'D:R'),WTCPercentLimit:0,ValveOpenTime:2000};
 const result=resolvePots([{pot_number:68,status:'confirmed',relay_address:32,channel:20}],[32],[old,active]).find(p=>p.pot===68);
 assert.equal(result.pairing.name,active.name);
 assert.equal(result.pairing.namedPot,68);
 assert.equal(old.WTCPercentLimit,0);
});

// ---------------------------------------------------------------- direct solenoid outputs

test('every configured output on all three boards is listed, including those without a sensor or pot', async () => {
  const { resolveOutputs } = await import('./hold-policy.mjs');
  const labels = Array.from({ length: 144 }, (_, index) => ({ solenoid_number: index + 1, relay_address: [36, 32, 38][Math.floor(index / 48)], channel: (index % 48) + 1, status: index === 73 ? 'confirmed' : 'needs_confirmation', source: 'pcb_label_scheme' }));
  const outputs = resolveOutputs({ boards, valves: [], labels, pots: resolvePots(routes, boards, live), pairings: live });
  assert.equal(outputs.length, 144);
  assert.deepEqual(outputs.slice(0, 2).map((o) => [o.solenoidNumber, o.relayAddress, o.channel]), [[1, 36, 1], [2, 36, 2]]);
  // Board boundaries: 48 ends 0x24, 49 starts 0x20, 96 ends 0x20, 97 starts 0x26.
  const byNumber = new Map(outputs.map((o) => [o.solenoidNumber, o]));
  assert.deepEqual([48, 49, 96, 97, 100].map((n) => [byNumber.get(n).relayAddress, byNumber.get(n).channel]), [[36, 48], [32, 1], [32, 48], [38, 1], [38, 4]]);
  assert.equal(byNumber.get(74).labelStatus, 'confirmed');
  // Solenoid 66 (0x20:18) waters physical pot 66 by its field route; its pairing is named for pot 16.
  assert.deepEqual(byNumber.get(66).pots, [66]);
  assert.equal(byNumber.get(66).pairing.name, 'Zone3-Pot16');
  // Solenoid 65 (0x20:17) has no recorded route: the physical pot stays unknown.
  assert.deepEqual(byNumber.get(65).pots, []);
});

test('solenoid numbers are never invented for unlabelled outputs', async () => {
  const { resolveOutputs } = await import('./hold-policy.mjs');
  const outputs = resolveOutputs({ boards: [32], valves: [{ relayAddress: '0x20', address: '26' }, { relayAddress: '0x20', address: '27' }], labels: [{ solenoid_number: 74, relay_address: 32, channel: 26, status: 'confirmed', source: 'field' }], pots: [], pairings: [] });
  assert.deepEqual(outputs.map((o) => [o.key, o.solenoidNumber]), [['0x20:26', 74], ['0x20:27', null]]);
});

test('a solenoid destination must be a configured output; a pot destination uses only its recorded route', async () => {
  const { resolveOutputs, resolveDestination } = await import('./hold-policy.mjs');
  const pots = resolvePots(routes, boards, live);
  const outputs = resolveOutputs({ boards, valves: [], labels: [], pots, pairings: live });
  assert.equal(resolveDestination({ kind: 'solenoid', relayAddress: 32, channel: 49 }, { pots, outputs, boards, role: 'researcher' }).ok, false);
  assert.equal(resolveDestination({ kind: 'solenoid', relayAddress: 40, channel: 1 }, { pots, outputs, boards, role: 'researcher' }).ok, false);
  const direct = resolveDestination({ kind: 'solenoid', relayAddress: 32, channel: 17 }, { pots, outputs, boards, role: 'researcher' });
  assert.deepEqual([direct.ok, direct.relayAddress, direct.channel, direct.potNumber, direct.routeStatus], [true, 32, 17, null, 'unknown']);
  const pot = resolveDestination({ kind: 'pot', potNumber: 16 }, { pots, outputs, boards, role: 'researcher' });
  assert.deepEqual([pot.ok, pot.relayAddress, pot.channel], [true, 36, 16]);
  assert.equal(resolveDestination({ kind: 'pot', potNumber: 2 }, { pots, outputs, boards, role: 'admin' }).ok, false);
  assert.equal(resolveDestination({ kind: 'pot', potNumber: 86 }, { pots, outputs, boards, role: 'admin' }).ok, false);
});

test('verified JWT claims are read without an Auth round trip and fail closed', async () => {
  const { verifiedClaims } = await import('./hold-policy.mjs');
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (claims) => `${encode({ alg: 'HS256' })}.${encode(claims)}.signature`;
  const sub = '0f0e0d0c-0b0a-4908-8706-050403020100';
  assert.deepEqual(verifiedClaims(token({ sub, role: 'authenticated', exp: 2_000 }), 1_000), { sub, exp: 2_000 });
  assert.equal(verifiedClaims(token({ sub, role: 'authenticated', exp: 999 }), 1_000), null);
  assert.equal(verifiedClaims(token({ sub, role: 'anon', exp: 2_000 }), 1_000), null);
  assert.equal(verifiedClaims(token({ sub: 'not-a-uuid', role: 'authenticated', exp: 2_000 }), 1_000), null);
  assert.equal(verifiedClaims('garbage', 1_000), null);
});

test('heartbeat caches expire and stay bounded', async () => {
  const { ttlCache } = await import('./hold-policy.mjs');
  let now = 0;
  const cache = ttlCache(5_000, 2, () => now);
  cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 3);
  now = 5_001;
  assert.equal(cache.get('c'), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";

import { holdExpiry, LEASE_MS, pairingPot, resolvePots, RECEIPT_LEASE_MS } from "./hold-policy.mjs";

const pairing = (name, relay, channel, extra = {}) => ({ name, sensorId: 600, valveId: 1600, Valve: { relayAddress: relay, address: String(channel) }, ...extra });
const live = [
  pairing("Zone3-Pot18", "0x24", 18),
  pairing("Zone2-Pot49", "0x20", 1),
  pairing("Zone4-Pot100", "0x20", 43),
  pairing("Zone3-Pot16", "0x20", 18),
];
const boards = [32, 36, 38];
const byPot = (pots) => new Map(pots.map((entry) => [entry.pot, entry]));

test("every pot 1-100 is listed, and only trusted routes are ready", () => {
  const pots = resolvePots(live, [], boards);
  assert.equal(pots.length, 100);
  assert.deepEqual(pots.filter((entry) => entry.status === "ready").map((entry) => entry.pot), [16, 18, 49, 100]);
  const map = byPot(pots);
  assert.equal(map.get(1).status, "unmapped");
  assert.match(map.get(1).reason, /No confirmed valve route/);
  assert.deepEqual([map.get(18).relayAddress, map.get(18).channel, map.get(18).kind], [36, 18, "pairing"]);
  // Pot number is never inferred from a channel number.
  assert.deepEqual([map.get(16).relayAddress, map.get(16).channel], [32, 18]);
});

test("admin-confirmed routes make unpaired pots ready, including pot 1 at a board boundary", () => {
  const map = byPot(resolvePots(live, [{ pot_number: 1, relay_address: 36, channel: 1, note: "", confirmed_at: "" }], boards));
  assert.deepEqual([map.get(1).status, map.get(1).kind, map.get(1).relayAddress, map.get(1).channel], ["ready", "manual", 36, 1]);
});

test("shared valves, duplicate pot claims and unconfigured boards are conflicts, never guesses", () => {
  const map = byPot(resolvePots(
    [...live, pairing("Zone1-Pot18", "0x24", 30)],
    [
      { pot_number: 5, relay_address: 36, channel: 18, note: "", confirmed_at: "" },
      { pot_number: 6, relay_address: 38, channel: 2, note: "", confirmed_at: "" },
    ],
    [32, 36],
  ));
  assert.equal(map.get(18).status, "conflict");
  assert.match(map.get(18).reason, /claimed by Zone3-Pot18 and Zone1-Pot18/);
  assert.equal(map.get(5).status, "conflict");
  assert.match(map.get(5).reason, /0x24:18 is also assigned to pot 18/);
  assert.equal(map.get(6).status, "conflict");
  assert.match(map.get(6).reason, /0x26 is not configured/);
});

test("a confirmed route that disagrees with a later pairing blocks the pot", () => {
  const map = byPot(resolvePots(live, [{ pot_number: 49, relay_address: 32, channel: 9, note: "", confirmed_at: "" }], boards));
  assert.equal(map.get(49).status, "conflict");
  assert.match(map.get(49).reason, /differs from Zone2-Pot49/);
});

test("only exact Zone-Pot names carry a pot number", () => {
  assert.equal(pairingPot("Zone3-Pot18"), 18);
  assert.equal(pairingPot("zone3-pot018"), 18);
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

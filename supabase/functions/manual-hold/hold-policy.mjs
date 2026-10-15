// Pure hold-to-water policy, shared by the Edge Function and its Node tests.

export const POT_COUNT = 100;
// A browser press time must be fresh when it reaches the server, and the controller lease
// never extends more than this past either the press or the server's receipt.
export const PRESS_MAX_AGE_MS = 2000;
export const PRESS_MAX_LEAD_MS = 1000;
export const LEASE_MS = 2500;
export const RECEIPT_LEASE_MS = 2000;

export const routeLabel = (relay, channel) => `0x${relay.toString(16)}:${channel}`;

/** Pot number in a pairing name like "Zone3-Pot18". Research labels only: not physical identity. */
export function pairingPot(name = "") {
  const match = /^(?:[A-Za-z][A-Za-z0-9 _]*-)?Zone\d+-Pot(\d{1,3})$/i.exec(name);
  return match ? Number(match[1]) : null;
}

function toInt(value) {
  const number = typeof value === "string" && /^0x/i.test(value) ? parseInt(value, 16) : Number(value);
  return Number.isInteger(number) ? number : null;
}

export function boardAddresses(boardConfig) {
  return (Array.isArray(boardConfig) ? boardConfig : []).map((board) => toInt(board?.address)).filter((value) => value != null);
}

/**
 * Resolve every physical pot 1-100 from its recorded valve route. Only a confirmed route on a
 * configured board, not shared with another pot, is ready. Sensor pairings never define a
 * pot's valve; a pairing on the same valve is reported for context and for the controller's
 * own route check.
 */
export function resolvePots(routes, boards, pairings) {
  const onValve = new Map();
  for (const pairing of pairings ?? []) {
    const relay = toInt(pairing?.Valve?.relayAddress), channel = toInt(pairing?.Valve?.address);
    if (relay == null || channel == null) continue;
    const key = routeLabel(relay, channel);
    onValve.set(key, [...(onValve.get(key) ?? []), pairing]);
  }
  const confirmedOwners = new Map();
  for (const row of routes ?? []) {
    if (row.status !== "confirmed" || row.relay_address == null) continue;
    const key = routeLabel(row.relay_address, row.channel);
    confirmedOwners.set(key, [...(confirmedOwners.get(key) ?? []), row.pot_number]);
  }
  const byPot = new Map((routes ?? []).map((row) => [row.pot_number, row]));
  const pots = [];
  for (let pot = 1; pot <= POT_COUNT; pot++) {
    const row = byPot.get(pot);
    if (!row) { pots.push({ pot, status: "unmapped", reason: "No recorded valve route" }); continue; }
    const base = { pot, source: row.source, evidence: row.evidence, updatedAt: row.updated_at };
    if (row.status === "no_water_line") { pots.push({ ...base, status: "no_water_line", reason: "No water line to this pot" }); continue; }
    if (row.status === "needs_confirmation") {
      pots.push({ ...base, status: "needs_confirmation", reason: "Recorded route needs a physical check",
        candidate: row.relay_address != null ? { relayAddress: row.relay_address, channel: row.channel } : null });
      continue;
    }
    const label = routeLabel(row.relay_address, row.channel);
    const sharing = (confirmedOwners.get(label) ?? []).filter((owner) => owner !== pot);
    const valvePairings = onValve.get(label) ?? [];
    const enabled = valvePairings.filter(item => Number(item.WTCPercentLimit) > 0 && Number(item.ValveOpenTime) > 0);
    const pairing = valvePairings.length === 1 ? valvePairings[0] : enabled.length === 1 ? enabled[0] : null;
    const entry = { ...base, relayAddress: row.relay_address, channel: row.channel,
      pairing: pairing ? { name: pairing.name, sensorKey: pairing.Sensor ? `${pairing.Sensor.boardSerialId}:${pairing.Sensor.address}` : null,
        namedPot: pairingPot(pairing.name), sensorId: pairing.sensorId, valveId: pairing.valveId } : null,
      sharedPairings: valvePairings.length > 1 ? valvePairings.map((item) => item.name) : undefined };
    if (sharing.length) pots.push({ ...entry, status: "conflict", reason: `Valve ${label} is also confirmed for pot ${sharing.join(", ")}` });
    else if (!boards.includes(row.relay_address)) pots.push({ ...entry, status: "conflict", reason: `Relay board 0x${row.relay_address.toString(16)} is not configured` });
    else pots.push({ ...entry, status: "ready" });
  }
  return pots;
}

/** The pot whose ready route is a pairing's valve (for portal builds that name a pairing). */
export function potForPairing(pots, pairings, name) {
  const pairing = (pairings ?? []).find((item) => item?.name === name);
  if (!pairing) return null;
  const relay = toInt(pairing.Valve?.relayAddress), channel = toInt(pairing.Valve?.address);
  return pots.find((entry) => entry.status === "ready" && entry.relayAddress === relay && entry.channel === channel)?.pot ?? null;
}

/** Controller expiry for a start/renew, or null when the press is too old or from the future. */
export function holdExpiry(sentAt, now) {
  if (!Number.isFinite(sentAt) || sentAt < now - PRESS_MAX_AGE_MS || sentAt > now + PRESS_MAX_LEAD_MS) return null;
  return Math.min(now + RECEIPT_LEASE_MS, sentAt + LEASE_MS);
}

/** Test only a server-recorded candidate, without marking physical identity confirmed. */
export function candidateTestRoute(pot, pots, boards, role) {
  const candidate = pot?.candidate;
  if (role !== 'admin' || pot?.status !== 'needs_confirmation' || !candidate
      || !boards.includes(candidate.relayAddress) || !Number.isInteger(candidate.channel)
      || candidate.channel < 1 || candidate.channel > 48) return null;
  if (pots.some(other => other.pot !== pot.pot && other.status === 'ready'
      && other.relayAddress === candidate.relayAddress && other.channel === candidate.channel)) return null;
  return { ...pot, ...candidate, status: 'ready', pairing: null };
}

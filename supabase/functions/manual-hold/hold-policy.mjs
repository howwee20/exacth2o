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

// ---------------------------------------------------------------- outputs (direct solenoid troubleshooting)

export const CHANNELS_PER_BOARD = 48;

function parseRelay(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  const text = String(value ?? "").trim();
  const number = /^0x/i.test(text) ? parseInt(text, 16) : Number(text);
  return Number.isInteger(number) ? number : null;
}

/**
 * Every configured valve output, identified by its board address and channel. The
 * inventory is the controller's own valve list when it reports one, otherwise every
 * channel of every configured board. A solenoid number appears only when a label is
 * recorded for that output; the physical pot appears only from a recorded route.
 *
 * @param {{ boards?: number[], valves?: any[], labels?: any[], pots?: any[], pairings?: any[] }} input
 */
export function resolveOutputs({ boards = [], valves = [], labels = [], pots = [], pairings = [] }) {
  const configured = new Set(boards);
  const keys = new Map();
  const add = (relay, channel) => {
    if (relay == null || !Number.isInteger(channel) || channel < 1 || channel > CHANNELS_PER_BOARD || !configured.has(relay)) return;
    keys.set(routeLabel(relay, channel), { relayAddress: relay, channel });
  };
  for (const valve of Array.isArray(valves) ? valves : []) add(parseRelay(valve?.relayAddress ?? valve?.RelayAddress), Number(valve?.address ?? valve?.Address));
  if (keys.size === 0) for (const relay of boards) for (let channel = 1; channel <= CHANNELS_PER_BOARD; channel++) add(relay, channel);

  const labelFor = new Map(labels.map((label) => [routeLabel(label.relay_address, label.channel), label]));
  const onValve = new Map();
  for (const pairing of pairings ?? []) {
    const relay = parseRelay(pairing?.Valve?.relayAddress), channel = Number(pairing?.Valve?.address);
    if (relay == null || !Number.isInteger(channel)) continue;
    const key = routeLabel(relay, channel);
    onValve.set(key, [...(onValve.get(key) ?? []), pairing]);
  }
  const confirmedPot = new Map();
  const candidatePot = new Map();
  for (const pot of pots) {
    if (pot.status === "ready" || pot.status === "conflict") {
      if (pot.relayAddress != null) confirmedPot.set(routeLabel(pot.relayAddress, pot.channel), [...(confirmedPot.get(routeLabel(pot.relayAddress, pot.channel)) ?? []), pot.pot]);
    } else if (pot.candidate) {
      const key = routeLabel(pot.candidate.relayAddress, pot.candidate.channel);
      candidatePot.set(key, [...(candidatePot.get(key) ?? []), pot.pot]);
    }
  }
  const boardOrder = new Map(boards.map((relay, index) => [relay, index]));
  return [...keys.values()]
    .map(({ relayAddress, channel }) => {
      const key = routeLabel(relayAddress, channel);
      const label = labelFor.get(key);
      const valvePairings = onValve.get(key) ?? [];
      const pairing = valvePairings.length === 1 ? valvePairings[0] : null;
      return {
        key,
        relayAddress,
        channel,
        solenoidNumber: label ? label.solenoid_number : null,
        labelStatus: label ? label.status : null,
        labelSource: label ? label.source : null,
        // Physical pot from a confirmed field route; "candidate" pots still need a check.
        pots: confirmedPot.get(key) ?? [],
        candidatePots: candidatePot.get(key) ?? [],
        pairing: pairing ? { name: pairing.name, sensorKey: pairing.Sensor ? `${pairing.Sensor.boardSerialId}:${pairing.Sensor.address}` : null, namedPot: pairingPot(pairing.name) } : null,
        sharedPairings: valvePairings.length > 1 ? valvePairings.map((item) => item.name) : undefined,
      };
    })
    .sort((a, b) => (a.solenoidNumber ?? 10_000) - (b.solenoidNumber ?? 10_000)
      || (boardOrder.get(a.relayAddress) ?? 99) - (boardOrder.get(b.relayAddress) ?? 99) || a.channel - b.channel);
}

/**
 * Resolves what the browser asked to water into one immutable output. A pot is
 * watered by its recorded route only; a solenoid must be a configured output. The
 * browser never supplies an address that the server has not resolved itself.
 */
/**
 * @param {any} destination
 * @param {{ pots: any[], outputs: any[], boards: number[], role: string, testCandidate?: boolean }} context
 */
export function resolveDestination(destination, { pots, outputs, boards, role, testCandidate = false }) {
  if (destination?.kind === "solenoid") {
    const relay = Number(destination.relayAddress), channel = Number(destination.channel);
    const output = outputs.find((item) => item.relayAddress === relay && item.channel === channel);
    if (!output) return { ok: false, status: 409, error: "That output is not configured on this controller" };
    return { ok: true, kind: "solenoid", relayAddress: relay, channel, solenoidNumber: output.solenoidNumber, potNumber: output.pots.length === 1 ? output.pots[0] : null,
      routeStatus: output.pots.length === 1 ? "confirmed_route" : output.candidatePots.length ? "candidate_route" : "unknown", pairingName: output.pairing?.name ?? null };
  }
  const potNumber = Number(destination?.potNumber);
  if (!Number.isInteger(potNumber) || potNumber < 1 || potNumber > POT_COUNT) return { ok: false, status: 409, error: "Pot route unavailable; refresh the list" };
  let pot = pots.find((entry) => entry.pot === potNumber) ?? { pot: potNumber, status: "unmapped", reason: "No recorded valve route" };
  if (testCandidate) {
    const tested = candidateTestRoute(pot, pots, boards, role);
    if (!tested) return { ok: false, status: 409, error: "Recorded candidate is unavailable for testing" };
    pot = tested;
  }
  if (pot.status !== "ready") return { ok: false, status: 409, error: pot.reason ?? "Pot route unavailable", pot };
  const output = outputs.find((item) => item.relayAddress === pot.relayAddress && item.channel === pot.channel);
  return { ok: true, kind: "pot", relayAddress: pot.relayAddress, channel: pot.channel, potNumber, solenoidNumber: output?.solenoidNumber ?? null,
    routeStatus: testCandidate ? "candidate_test" : "confirmed_route", pairingName: pot.pairing?.name ?? null };
}

/**
 * Claims from a JWT that the Supabase gateway already verified (verify_jwt = true).
 * Used on the renewal and stop paths so a heartbeat needs no Auth round trip; the
 * start path still calls Auth. Returns null for anything malformed or expired.
 */
export function verifiedClaims(jwt, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=")), (c) => c.charCodeAt(0))));
    if (typeof json.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(json.sub)) return null;
    if (json.role !== "authenticated") return null;
    if (!Number.isFinite(json.exp) || json.exp <= nowSeconds) return null;
    return { sub: json.sub, exp: json.exp };
  } catch {
    return null;
  }
}

/** Small TTL cache for per-heartbeat checks (role, intake gate). Bounded in size. */
export function ttlCache(ttlMs, maxEntries = 500, now = () => Date.now()) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ttlMs) { entries.delete(key); return undefined; }
      return entry.value;
    },
    set(key, value) {
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { value, at: now() });
    },
    delete(key) { entries.delete(key); },
  };
}

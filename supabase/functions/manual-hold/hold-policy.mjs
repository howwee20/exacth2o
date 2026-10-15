// Pure hold-to-water policy, shared by the Edge Function and its Node tests.

export const POT_COUNT = 100;
// A browser press time must be fresh when it reaches the server, and the controller lease
// never extends more than this past either the press or the server's receipt.
export const PRESS_MAX_AGE_MS = 2000;
export const PRESS_MAX_LEAD_MS = 1000;
export const LEASE_MS = 2500;
export const RECEIPT_LEASE_MS = 2000;

export const routeLabel = (relay, channel) => `0x${relay.toString(16)}:${channel}`;

/** Pot number of a pairing named like "Zone3-Pot18"; null for any other name. */
export function pairingPot(name = "") {
  const match = /^Zone\d+-Pot(\d{1,3})$/i.exec(name);
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
 * Resolve every physical pot 1-100 to exactly one valve route, refusing anything ambiguous.
 * Paired pots use their live controller pairing; unpaired pots use an admin-confirmed route.
 * A route shared by two pots, a pot claimed twice, or an unconfigured board is a conflict.
 */
export function resolvePots(pairings, manualRoutes, boards) {
  const pots = new Map();
  for (let pot = 1; pot <= POT_COUNT; pot++) pots.set(pot, { pot, status: "unmapped", reason: "No confirmed valve route" });
  const owners = new Map();
  const claim = (relay, channel, owner) => {
    const key = routeLabel(relay, channel);
    owners.set(key, [...(owners.get(key) ?? []), owner]);
  };
  const conflict = (pot, reason) => Object.assign(pots.get(pot), { status: "conflict", reason });

  const paired = new Map();
  for (const pairing of pairings ?? []) {
    const relay = toInt(pairing?.Valve?.relayAddress), channel = toInt(pairing?.Valve?.address), pot = pairingPot(pairing?.name);
    if (relay != null && channel != null) claim(relay, channel, pot != null && pot >= 1 && pot <= POT_COUNT ? `pot ${pot}` : pairing?.name ?? "another pairing");
    if (pot != null && pot >= 1 && pot <= POT_COUNT) paired.set(pot, [...(paired.get(pot) ?? []), pairing]);
  }
  for (const [pot, claims] of paired) {
    if (claims.length > 1) { conflict(pot, `Pot ${pot} is claimed by ${claims.map((item) => item.name).join(" and ")}`); continue; }
    const [pairing] = claims, relay = toInt(pairing.Valve?.relayAddress), channel = toInt(pairing.Valve?.address);
    if (relay == null || channel == null) { conflict(pot, `${pairing.name} has no valve route`); continue; }
    Object.assign(pots.get(pot), { status: "ready", kind: "pairing", relayAddress: relay, channel, pairingName: pairing.name,
      sensorId: pairing.sensorId, valveId: pairing.valveId, reason: undefined });
  }
  for (const route of manualRoutes ?? []) {
    const entry = pots.get(route.pot_number);
    if (!entry || entry.status === "conflict") continue;
    if (entry.kind === "pairing") {
      if (entry.relayAddress !== route.relay_address || entry.channel !== route.channel) {
        conflict(route.pot_number, `Confirmed route ${routeLabel(route.relay_address, route.channel)} differs from ${entry.pairingName}`);
      }
      continue;
    }
    claim(route.relay_address, route.channel, `pot ${route.pot_number}`);
    Object.assign(entry, { status: "ready", kind: "manual", relayAddress: route.relay_address, channel: route.channel,
      note: route.note, confirmedAt: route.confirmed_at, reason: undefined });
  }
  for (const entry of pots.values()) {
    if (entry.status !== "ready") continue;
    const label = routeLabel(entry.relayAddress, entry.channel);
    const sharing = (owners.get(label) ?? []).filter((owner) => owner !== `pot ${entry.pot}`);
    if (sharing.length) conflict(entry.pot, `Valve ${label} is also assigned to ${sharing.join(", ")}`);
    else if (!boards.includes(entry.relayAddress)) conflict(entry.pot, `Relay board 0x${entry.relayAddress.toString(16)} is not configured`);
  }
  return [...pots.values()];
}

/** Controller expiry for a start/renew, or null when the press is too old or from the future. */
export function holdExpiry(sentAt, now) {
  if (!Number.isFinite(sentAt) || sentAt < now - PRESS_MAX_AGE_MS || sentAt > now + PRESS_MAX_LEAD_MS) return null;
  return Math.min(now + RECEIPT_LEASE_MS, sentAt + LEASE_MS);
}

// Validation for the two atomic topology commands used by full-scale autocalibration.
// Pure so the Edge Function and its Node tests share it.

export const MAX_TOPOLOGY_ITEMS = 200;
export const MAX_TOPOLOGY_PAYLOAD_BYTES = 64_000;

function text(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// Research pairing names, including prefixed ones such as "Huiqiao-Zone3-Pot68".
const pairingNamePattern = /^(?:[A-Za-z][A-Za-z0-9 _]*-)?Zone\d+-Pot\d+$/i;
const sensorKeyPattern = /^[A-Za-z0-9_.-]{1,80}:[A-Za-z0-9]{1,8}$/;
const valveKeyPattern = /^0x[0-9a-f]{1,2}:\d{1,2}$/i;

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/**
 * A reviewed valve permutation: every valve one pot gives up is received by another
 * pot in the same change, so no valve is orphaned or shared and a swap or a cycle
 * of any length (up to every pot) moves as one unit.
 */
export function validateRemapPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Remap payload must be an object");
  if (JSON.stringify(raw).length > MAX_TOPOLOGY_PAYLOAD_BYTES) throw new Error("Remap payload is too large");
  const remapId = text(raw.remap_id, 120);
  if (!remapId) throw new Error("A remap ID is required");
  if (!Array.isArray(raw.changes) || raw.changes.length < 1 || raw.changes.length > MAX_TOPOLOGY_ITEMS) {
    throw new Error(`A remap must include 1-${MAX_TOPOLOGY_ITEMS} valve changes`);
  }
  const changes = raw.changes.map((change, index) => {
    const pairing = text(change?.pairing_name, 120);
    const sensor = text(change?.sensor_key, 120);
    const from = text(change?.from_valve_key, 40);
    const to = text(change?.to_valve_key, 40);
    if (!pairingNamePattern.test(pairing)) throw new Error(`Change ${index + 1}: pairing name is invalid`);
    if (!sensorKeyPattern.test(sensor)) throw new Error(`Change ${index + 1}: sensor identity is invalid`);
    if (!valveKeyPattern.test(from) || !valveKeyPattern.test(to)) throw new Error(`Change ${index + 1}: valve identity is invalid`);
    if (from.toLowerCase() === to.toLowerCase()) throw new Error(`${pairing} already uses valve ${to}`);
    return { pairing_name: pairing, sensor_key: sensor, from_valve_key: from, to_valve_key: to };
  });
  const lower = (values) => values.map((value) => value.toLowerCase());
  const names = duplicates(lower(changes.map((change) => change.pairing_name)));
  if (names.length) throw new Error(`Pairings appear more than once: ${names.join(", ")}`);
  // Sensor addresses are case-sensitive SDI-12 identities.
  const sensors = duplicates(changes.map((change) => change.sensor_key));
  if (sensors.length) throw new Error(`Sensors appear more than once: ${sensors.join(", ")}`);
  const given = lower(changes.map((change) => change.from_valve_key));
  const received = lower(changes.map((change) => change.to_valve_key));
  if (duplicates(given).length) throw new Error("A valve is given away twice");
  if (duplicates(received).length) throw new Error("A valve is received twice");
  const givenSet = new Set(given);
  const receivedSet = new Set(received);
  const orphaned = [...givenSet].filter((valve) => !receivedSet.has(valve));
  const unexplained = [...receivedSet].filter((valve) => !givenSet.has(valve));
  if (orphaned.length || unexplained.length) {
    throw new Error("A remap must be a complete swap or cycle: every valve given up must be received by another pot in the same change");
  }
  return { remap_id: remapId, changes };
}

/** Each pot's own recorded settings, restored exactly (milliseconds, not rounded seconds). */
export function validateRestorePayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Restore payload must be an object");
  if (JSON.stringify(raw).length > MAX_TOPOLOGY_PAYLOAD_BYTES) throw new Error("Restore payload is too large");
  if (!Array.isArray(raw.pairings) || raw.pairings.length < 1 || raw.pairings.length > MAX_TOPOLOGY_ITEMS) {
    throw new Error(`A restore must include 1-${MAX_TOPOLOGY_ITEMS} pots`);
  }
  const pairings = raw.pairings.map((entry, index) => {
    const pairing = text(entry?.pairing_name, 120);
    if (!pairingNamePattern.test(pairing)) throw new Error(`Pot ${index + 1}: pairing name is invalid`);
    const sensor = text(entry?.sensor_key, 120);
    const valve = text(entry?.valve_key, 40);
    if (sensor && !sensorKeyPattern.test(sensor)) throw new Error(`${pairing}: sensor identity is invalid`);
    if (valve && !valveKeyPattern.test(valve)) throw new Error(`${pairing}: valve identity is invalid`);
    const target = entry?.target_vwc;
    if (!(target === null || (typeof target === "number" && Number.isFinite(target) && target >= 0 && target <= 100))) {
      throw new Error(`${pairing}: target must be 0-100% or null (watering disabled)`);
    }
    const open = entry?.valve_open_time_ms;
    const interval = entry?.measurement_interval_ms;
    if (!Number.isInteger(open) || open < 0 || open > 120_000) throw new Error(`${pairing}: pulse length must be 0-120000 ms`);
    if (!Number.isInteger(interval) || interval < 30_000 || interval > 3_600_000) throw new Error(`${pairing}: interval must be 30000-3600000 ms`);
    return {
      pairing_name: pairing,
      ...(sensor ? { sensor_key: sensor } : {}),
      ...(valve ? { valve_key: valve } : {}),
      target_vwc: target,
      valve_open_time_ms: open,
      measurement_interval_ms: interval,
    };
  });
  const names = duplicates(pairings.map((entry) => entry.pairing_name.toLowerCase()));
  if (names.length) throw new Error(`Pots appear more than once: ${names.join(", ")}`);
  return { pairings };
}

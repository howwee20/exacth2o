export const mattControlPairingNames = Object.freeze([
  ...Array.from({ length: 10 }, (_, index) => `Zone2-Pot${index + 41}`),
  ...Array.from({ length: 10 }, (_, index) => `Zone4-Pot${index + 91}`),
]);

const mattControlPairingNameSet = new Set(mattControlPairingNames);

export function isMattControlPairing(value) {
  return mattControlPairingNameSet.has(String(value ?? ""));
}

export function hasRdSystemAdminAccess(portalRole, explicitlyAllowed) {
  return portalRole === "admin" && explicitlyAllowed === true;
}

export function actualByHorizon(readings, pairing, openedAt, minutes) {
  const values = new Map();
  const nearestDeltaByMinute = new Map();
  if (!openedAt) return values;
  const openedMs = Date.parse(openedAt);
  if (!Number.isFinite(openedMs)) return values;
  const rows = readings
    .filter((reading) =>
      reading.pairing_name === pairing &&
      Number.isFinite(Number(reading.calibrated_value)) &&
      Number.isFinite(Date.parse(String(reading.device_recorded_at ?? "")))
    )
    .sort((left, right) =>
      Date.parse(String(left.device_recorded_at)) -
      Date.parse(String(right.device_recorded_at))
    );
  const baseline = rows
    .filter((reading) =>
      Date.parse(String(reading.device_recorded_at)) <= openedMs
    )
    .at(-1);
  if (baseline) values.set(0, Number(baseline.calibrated_value));

  for (const reading of rows) {
    const recordedMs = Date.parse(String(reading.device_recorded_at));
    if (recordedMs <= openedMs) continue;
    const elapsed = (recordedMs - openedMs) / 60_000;
    const horizon = minutes
      .filter((minute) => minute > 0)
      .map((minute) => ({ minute, delta: Math.abs(minute - elapsed) }))
      .sort((left, right) => left.delta - right.delta)[0];
    if (!horizon || horizon.delta > 6) continue;
    const previousDelta = nearestDeltaByMinute.get(horizon.minute);
    if (previousDelta != null && previousDelta <= horizon.delta) continue;
    nearestDeltaByMinute.set(horizon.minute, horizon.delta);
    values.set(horizon.minute, Number(reading.calibrated_value));
  }
  return values;
}

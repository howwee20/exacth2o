// User-confirmed physical routes, 2026-11-01. Pot numbers are physical identities.
export const FIELD_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
export const FIELD_DEVICE_ID = '3100e37ee3205651fe3dd86dafd4dc0c';
export const FIELD_MAP_VERSION = '2026-11-01';
export const UNRESOLVED_POTS = Object.freeze([63, 87, 88, 89, 90]);
export const PROTECTED_POTS = Object.freeze(Array.from({length: 12}, (_, i) => i + 65));

export const FIELD_MAP = Object.freeze(Array.from({length: 100}, (_, i) => {
  const pot = i + 1;
  const status = UNRESOLVED_POTS.includes(pot) ? 'unresolved' : PROTECTED_POTS.includes(pot) ? 'protected' : 'verified';
  let output = status === 'unresolved' ? null : pot;
  if (pot === 83) output = 84;
  if (pot === 84) output = 83;
  if (pot === 86) output = 96;
  if (pot >= 96) output = pot - 10;
  const relayAddress = output == null ? null : output <= 48 ? 36 : 32;
  const channel = output == null ? null : output <= 48 ? output : output - 48;
  return Object.freeze({pot, output, relayAddress, channel, status});
}));

export function isFieldInstallation(projectId, deviceId) {
  return projectId === FIELD_PROJECT_ID && deviceId === FIELD_DEVICE_ID;
}

export function normalizedValveKey(value) {
  const match = /^(0x[0-9a-f]+|\d+):(\d+)$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  return `${Number(match[1])}:${Number(match[2])}`;
}

export function fieldPotForValve(value) {
  const key = normalizedValveKey(value);
  return FIELD_MAP.find(row => row.relayAddress != null && `${row.relayAddress}:${row.channel}` === key) ?? null;
}

export function fieldValveBlockReason(value) {
  const key = normalizedValveKey(value);
  if (key === '32:15') return 'Pot 63 is excluded until its route is fixed.';
  const row = fieldPotForValve(value);
  if (!row) return 'This output has no confirmed physical pot route.';
  if (row.status === 'protected') return 'Pan’s live experiment is protected.';
  return null;
}

/** Enforced at command intake as well as in the map. No hardware is operated here. */
export function assertAutocalibrationCommandsAllowed({projectId, deviceId, commands, pairings}) {
  if (!isFieldInstallation(projectId, deviceId)) return;
  const byName = new Map(pairings.map(pairing => [pairing.name, pairing]));
  const checkKey = key => {
    const reason = fieldValveBlockReason(key);
    if (reason) throw new Error(reason);
  };
  const checkName = name => {
    const pairing = byName.get(name);
    if (!pairing) throw new Error(`Pairing ${name} is no longer configured.`);
    const valve = pairing.Valve ?? pairing.valve;
    checkKey(pairing.valve_key ?? `${valve?.relayAddress ?? valve?.RelayAddress}:${valve?.address ?? valve?.Address}`);
  };
  for (const command of commands) {
    const type = command.command_type ?? command.commandType;
    const payload = command.payload ?? {};
    if (type === 'update_system_state') continue;
    if (!['manual_water', 'bulk_update_pairings', 'update_pairing', 'remap_pairing_valves', 'restore_pairing_settings'].includes(type)) {
      throw new Error('This operation is not part of autocalibration.');
    }
    const names = payload.pairing_names ?? (payload.pairing_name ? [payload.pairing_name] : []);
    for (const name of names) checkName(name);
    for (const entry of payload.changes ?? payload.pairings ?? []) {
      checkName(entry.pairing_name);
      if (entry.from_valve_key) checkKey(entry.from_valve_key);
      if (entry.to_valve_key) checkKey(entry.to_valve_key);
      if (entry.valve_key) checkKey(entry.valve_key);
    }
    if (!names.length && !(payload.changes?.length || payload.pairings?.length)) throw new Error('Choose confirmed pots for autocalibration.');
  }
}

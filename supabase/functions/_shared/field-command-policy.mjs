import {FIELD_PROJECT_ID, FIELD_DEVICE_ID, fieldPotForValve, normalizedValveKey} from './installation-field-map.mjs';

export function isFieldScope(projectId, deviceId) {
  return projectId === FIELD_PROJECT_ID || deviceId === FIELD_DEVICE_ID;
}
export function assertFieldIdentity(projectId, deviceId) {
  if (isFieldScope(projectId, deviceId) && (projectId !== FIELD_PROJECT_ID || deviceId !== FIELD_DEVICE_ID)) {
    throw new Error('Field installation identity changed; verify its physical map before operating valves.');
  }
}
export function assertKnownFieldRoute(projectId, deviceId, valveKey) {
  if (!isFieldScope(projectId, deviceId)) return;
  assertFieldIdentity(projectId, deviceId);
  if (!fieldPotForValve(valveKey)) throw new Error('This valve has no confirmed physical pot route.');
}
function valveOf(p) {
  const keys = [p.valve_key, p.Valve && `${p.Valve.relayAddress}:${p.Valve.address}`, p.valve && `${p.valve.relayAddress}:${p.valve.address}`].filter(Boolean).map(normalizedValveKey);
  if (!keys.length || keys.some(k => !k || k !== keys[0])) throw new Error('Ambiguous valve identity; review the pairing.');
  return keys[0];
}
export function assertFieldCommandsAllowed({projectId, deviceId, commands, pairings, bindings = []}) {
  if (!isFieldScope(projectId, deviceId)) return;
  if (commands.every(c => ['update_system_state','delete_pairing'].includes(c.command_type ?? c.commandType))) return;
  const byName = new Map();
  for (const p of pairings) {
    const name = String(p.name).toLowerCase();
    if (byName.has(name)) throw new Error('Ambiguous pairing names; review the controller configuration.');
    byName.set(name, p);
  }
  const pairing = name => {
    const p = byName.get(String(name).toLowerCase());
    if (!p) throw new Error('Pairing no longer exists; refresh the controller configuration.');
    return p;
  };
  const check = (key, p, enabling) => {
    assertKnownFieldRoute(projectId, deviceId, key);
    const pot = fieldPotForValve(key)?.pot;
    if (enabling && [83,84,86,96,97,98,99,100].includes(pot)) {
      const sensor = p.sensor_key ?? (p.Sensor && `${p.Sensor.boardSerialId}:${p.Sensor.address}`);
      if (!bindings.some(b => b.sensor_key === sensor && normalizedValveKey(b.valve_key) === normalizedValveKey(key) && ['researcher_confirmed','delivery_verified'].includes(b.physical_status))) {
        throw new Error('Confirm this sensor and corrected valve destination before enabling automatic watering.');
      }
    }
  };
  for (const c of commands) {
    const type = c.command_type ?? c.commandType, p = c.payload ?? {};
    // Stop/close and sensing-only changes must remain available.
    if (type === 'update_system_state' || type === 'delete_pairing') continue;
    if (type === 'manual_water') {
      for (const name of p.pairing_names ?? []) check(valveOf(pairing(name)), pairing(name), false);
    } else if (type === 'create_pairing') {
      check(p.valve_key, p, true);
    } else if (['update_pairing','bulk_update_pairings'].includes(type)) {
      if (p.disable_watering === true || !('target_vwc' in p || 'open_time_seconds' in p || p.disable_watering === false)) continue;
      for (const name of p.pairing_names ?? [p.pairing_name]) check(valveOf(pairing(name)), pairing(name), true);
    } else if (type === 'restore_pairing_settings') {
      for (const row of p.pairings ?? []) {
        if (row.target_vwc === null || row.valve_open_time_ms === 0) continue;
        const existing = pairing(row.pairing_name);
        check(row.valve_key ?? valveOf(existing), {...existing, ...row}, true);
      }
    } else if (type === 'remap_pairing_valves') {
      for (const row of p.changes ?? []) {
        const existing = pairing(row.pairing_name);
        const active = Number(existing.WTCPercentLimit) >= 0 && Number(existing.WTCPercentLimit) <= 100 && Number(existing.ValveOpenTime) > 0;
        check(row.to_valve_key, {...existing, ...row}, active);
      }
    }
  }
}
export async function checkFieldCommands(admin, projectId, deviceId, commands) {
  if (!isFieldScope(projectId, deviceId)) return;
  const [config, bindings] = await Promise.all([
    admin.from('device_config_state').select('pairings').eq('project_id', projectId).eq('device_id', deviceId).maybeSingle(),
    admin.from('hardware_bindings').select('sensor_key,valve_key,physical_status').eq('project_id', projectId).eq('device_id', deviceId).is('retired_at', null),
  ]);
  if (config.error || bindings.error || !Array.isArray(config.data?.pairings)) throw new Error('The physical route configuration could not be verified.');
  assertFieldCommandsAllowed({projectId,deviceId,commands,pairings:config.data.pairings,bindings:bindings.data ?? []});
}

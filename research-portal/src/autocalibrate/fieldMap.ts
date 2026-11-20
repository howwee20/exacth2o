import {FIELD_MAP, fieldPotForValve, fieldValveBlockReason, isFieldInstallation, type FieldMapRow} from '../../../supabase/functions/_shared/installation-field-map.mjs';
import type {PairingRow} from '../types';
import type {PotAvailability} from './selection';
import {parseValveKey} from './workspaceContext';

export {FIELD_MAP, type FieldMapRow};

export function installationFieldMap(projectId: string, deviceId: string): readonly FieldMapRow[] | null {
  return isFieldInstallation(projectId, deviceId) ? FIELD_MAP : null;
}

// Preserve controller identities and settings. Only the displayed physical pot changes.
export function physicalPairings(pairings: readonly PairingRow[], map: readonly FieldMapRow[] | null): PairingRow[] {
  if (!map) return [...pairings];
  return pairings.map(pairing => {
    const physical = fieldPotForValve(pairing.valve_key);
    return physical ? {...pairing, pot_number: physical.pot, zone: Math.ceil(physical.pot / 25)} : pairing;
  });
}

export function physicalPotRows(
  map: readonly FieldMapRow[] | null,
  pairings: readonly PairingRow[],
  availability: ReadonlyMap<string, PotAvailability>,
) {
  return Array.from({length: 100}, (_, index) => {
    const pot = index + 1;
    const field = map?.find(row => row.pot === pot);
    const owners = pairings.filter(pairing => {
      if (pairing.pot_number !== pot) return false;
      if (!field) return true;
      const valve = parseValveKey(pairing.valve_key);
      return valve?.relayAddress === field.relayAddress && valve.channel === field.channel;
    });
    const pairing = owners.find(row => availability.get(row.name)?.available) ?? owners[0];
    const valve = field ?? (pairing ? parseValveKey(pairing.valve_key) : null);
    const ready = Boolean(pairing && availability.get(pairing.name)?.available &&
      field?.status !== 'unresolved' && field?.status !== 'protected');
    return {pot, field, pairing, valve, ready};
  });
}

export function fieldSelectionBlockReason(pairings: readonly Pick<PairingRow, 'valve_key'>[], map: readonly FieldMapRow[] | null): string | null {
  if (!map) return null;
  for (const pairing of pairings) {
    const reason = fieldValveBlockReason(pairing.valve_key);
    if (reason) return reason;
  }
  return null;
}

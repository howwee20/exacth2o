import {FIELD_MAP, fieldPotForValve, fieldValveBlockReason, isFieldInstallation, type FieldMapRow} from '../../../supabase/functions/_shared/installation-field-map.mjs';
import type {PairingRow} from '../types';

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

export function fieldSelectionBlockReason(pairings: readonly Pick<PairingRow, 'valve_key'>[], map: readonly FieldMapRow[] | null): string | null {
  if (!map) return null;
  for (const pairing of pairings) {
    const reason = fieldValveBlockReason(pairing.valve_key);
    if (reason) return reason;
  }
  return null;
}

import { experimentDraftFromPortalExperiment, type ExperimentDraft } from '../experimentSpec';
import type { PortalExperiment } from '../experimentRegistry';
import type { PairingRow } from '../types';

export function targetDraft(experiment: PortalExperiment, pairings: PairingRow[], names: readonly string[], target: number): ExperimentDraft {
  if (!Number.isInteger(target) || target < 0 || target > 80) throw new Error('Choose a whole-number target between 0% and 80%.');
  const selected = new Set(names);
  if (!selected.size || names.some(name => !experiment.pairingNames.includes(name))) throw new Error('Choose pots in this experiment.');
  const draft = experimentDraftFromPortalExperiment(experiment, pairings);
  // Baseline every control from the current inventory, so changing a subgroup cannot replay stale settings elsewhere.
  draft.assignments = draft.assignments.map(a => {
    const p = pairings.find(p => p.name === a.pairing_name);
    if (!p) throw new Error('Refresh the pot inventory before changing a target.');
    const enabled = p.wtc_percent_limit >= 0 && p.valve_open_time_ms > 0;
    if (selected.has(a.pairing_name) && !enabled) throw new Error('This pot has watering disabled. Enable watering in the experiment editor first.');
    return {...a, watering_enabled: enabled, target_vwc_percent: selected.has(a.pairing_name) ? target : enabled ? p.wtc_percent_limit : null,
      valve_open_seconds: enabled ? p.valve_open_time_ms / 1000 : null, measurement_interval_minutes: p.measurement_interval_ms / 60000};
  });
  return {...draft, controller_changes_requested: true};
}

export function commandOutcome(ids: string[], rows: {id: string; status: string}[]): 'pending' | 'applied' | 'failed' {
  const states = ids.map(id => rows.find(row => row.id === id)?.status);
  if (states.some(s => ['failed','canceled','expired','rejected'].includes(s ?? ''))) return 'failed';
  return ids.length > 0 && states.every(s => s === 'succeeded') ? 'applied' : 'pending';
}

import { useMemo } from "react";
import { Check } from "lucide-react";
import { PhysicalPotMap } from "./autocalibrate/PhysicalPotMap";
import { physicalPairings, physicalPotRows, type FieldMapRow } from "./autocalibrate/fieldMap";
import type { PotAvailability } from "./autocalibrate/selection";
import type { ExperimentPotOccupancy } from "./experimentRegistry";
import type { PairingRow } from "./types";

const noAvailability = new Map<string, PotAvailability>();

export function useExperimentFieldPots(
  fieldMap: readonly FieldMapRow[] | null,
  pairings: readonly PairingRow[],
  occupiedByName: ReadonlyMap<string, readonly ExperimentPotOccupancy[]>,
) {
  return useMemo(() => {
    if (!fieldMap) return null;
    const rows = physicalPotRows(fieldMap, physicalPairings(pairings, fieldMap), noAvailability);
    const available = new Map<number, PairingRow | null>();
    const occupancy = new Map<number, string>();
    const assignable = new Set<string>();
    const potNumbers = new Map<string, number>();
    for (const { pot, field, owners } of rows) {
      for (const owner of owners) potNumbers.set(owner.name, pot);
      if (field?.status !== "verified") continue;
      const experiments = new Set(owners.flatMap(owner =>
        (occupiedByName.get(owner.name) ?? []).map(item => item.experimentName)));
      if (experiments.size) {
        occupancy.set(pot, "In use by " + [...experiments].join(", "));
        continue;
      }
      // A verified valve route can be selected even before it has a controller pairing.
      const pairing = owners.length === 1 ? owners[0] : null;
      available.set(pot, pairing);
      if (pairing) assignable.add(pairing.name);
    }
    return { fieldMap, available, occupancy, assignable, potNumbers };
  }, [fieldMap, occupiedByName, pairings]);
}

type PickerProps = {
  model: NonNullable<ReturnType<typeof useExperimentFieldPots>>;
  selected: ReadonlySet<string>;
  unpairedPots: ReadonlySet<number>;
  onToggle: (pot: number) => void;
  onRemovePairing: (name: string) => void;
};

export function ExperimentPotPicker({ model, selected, unpairedPots, onToggle, onRemovePairing }: PickerProps) {
  const selectedInOrder = [
    ...[...selected].map(name => ({ name, number: model.potNumbers.get(name) ?? null })),
    ...[...unpairedPots].map(number => ({ name: null, number })),
  ].sort((left, right) => (left.number ?? 101) - (right.number ?? 101));
  const selectedNumbers = new Set(selectedInOrder.flatMap(pot => pot.number == null ? [] : [pot.number]));
  const available = [...model.available.keys()].filter(pot => !selectedNumbers.has(pot));
  return (
    <div className="experiment-builder-pot-section experiment-builder-field-picker">
      <div className="experiment-builder-section-heading">
        <h3>Pots</h3>
        <span aria-live="polite">{selectedInOrder.length} selected · {available.length} available</span>
      </div>
      <PhysicalPotMap
        map={model.fieldMap}
        experimentPicker={{
          selected: selectedNumbers,
          isAvailable: pot => model.available.has(pot),
          occupancy: model.occupancy,
          onToggle,
        }}
      />
      <section aria-labelledby="available-experiment-pots">
        <h4 id="available-experiment-pots">Available</h4>
        {available.length ? (
          <div className="experiment-builder-pot-grid">
            {available.map(pot => <button type="button" key={pot} onClick={() => onToggle(pot)}>
              <span>Pot {pot}</span>
            </button>)}
          </div>
        ) : <p className="settings-muted">No available pots.</p>}
      </section>
      <section aria-labelledby="selected-experiment-pots">
        <h4 id="selected-experiment-pots">Selected</h4>
        {selectedInOrder.length ? (
          <div className="experiment-builder-pot-grid">
            {selectedInOrder.map(({ name, number }) => {
              const label = number == null ? name : "Pot " + number;
              return <button type="button" key={name ?? number} className="is-selected" aria-label={"Remove " + label} onClick={() => {
                if (name !== null) onRemovePairing(name);
                else if (number !== null) onToggle(number);
              }}>
                <span>{label}</span>
                {name === null ? <small>Needs controller pairing</small>
                  : !model.assignable.has(name) ? <small>Unavailable</small>
                    : <Check size={14} aria-hidden="true" />}
              </button>;
            })}
          </div>
        ) : <p className="settings-muted">No pots selected.</p>}
      </section>
    </div>
  );
}

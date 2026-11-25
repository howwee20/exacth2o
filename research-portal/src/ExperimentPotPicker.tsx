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
      if(owners.length>1){occupancy.set(pot,"More than one pairing uses this valve");continue;}
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
  pendingLabel?: (pot:number)=>string|undefined;
  onRemovePending?: (pot:number)=>void;
  groupLabel?: (name: string) => string | undefined;
};

export function ExperimentPotPicker({ model, selected, unpairedPots, onToggle, onRemovePairing, groupLabel, pendingLabel, onRemovePending }: PickerProps) {
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
      {/* The map is the picker. Chosen pots are listed once more only to show each one's group and what it still needs. */}
      {selectedInOrder.length ? <section aria-labelledby="selected-experiment-pots">
        <h4 id="selected-experiment-pots">Selected</h4>
        {(
          <div className="experiment-builder-pot-grid">
            {selectedInOrder.map(({ name, number }) => {
              const label = number == null ? name : "Pot " + number;
              return <button type="button" key={name ?? number} className="is-selected" aria-label={"Remove " + label} onClick={() => {
                if (name !== null) onRemovePairing(name);
                else if (number !== null) (onRemovePending ?? onToggle)(number);
              }}>
                <span>{label}</span>
                {name === null ? <small>{number!==null && pendingLabel?.(number)} · Autopair needed</small>
                  : !model.assignable.has(name) ? <small>Unavailable</small>
                    : <><small>{groupLabel?.(name)}</small><Check size={14} aria-hidden="true" /></>}
              </button>;
            })}
          </div>
        )}
      </section> : null}
    </div>
  );
}

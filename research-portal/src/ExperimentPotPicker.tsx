import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { PhysicalPotMap } from "./autocalibrate/PhysicalPotMap";
import { physicalPairings, physicalPotRows, type FieldMapRow } from "./autocalibrate/fieldMap";
import { potAvailability, readingLookbackMs } from "./autocalibrate/selection";
import { createSupabaseTelemetryReader } from "./commissioningSupabasePorts";
import type { ExperimentPotOccupancy } from "./experimentRegistry";
import type { PairingRow } from "./types";

type ReadingCheck = {
  scope: string;
  checkedAt: number;
  latest: Map<string, number> | null;
};

export function useExperimentFieldPots(
  fieldMap: readonly FieldMapRow[] | null,
  projectId: string,
  deviceId: string | null,
  pairings: readonly PairingRow[],
  occupiedByName: ReadonlyMap<string, readonly ExperimentPotOccupancy[]>,
) {
  const physical = useMemo(() => physicalPairings(pairings, fieldMap), [fieldMap, pairings]);
  const sensorKeys = JSON.stringify([...new Set(physical.map(pairing => pairing.sensor_key).filter(Boolean))].sort());
  const lookback = readingLookbackMs(physical);
  const scope = fieldMap && deviceId ? JSON.stringify([projectId, deviceId, sensorKeys, lookback]) : null;
  const [check, setCheck] = useState<ReadingCheck | null>(null);

  useEffect(() => {
    if (!scope || !deviceId) return;
    let cancelled = false;
    const keys: string[] = JSON.parse(sensorKeys);
    const refresh = async () => {
      try {
        const reader = createSupabaseTelemetryReader({ projectId, deviceId });
        const rows = await reader.read(keys, Date.now() - lookback);
        const latest = new Map<string, number>();
        for (const row of rows) {
          if (row.atMs > (latest.get(row.sensorKey) ?? 0)) latest.set(row.sensorKey, row.atMs);
        }
        if (!cancelled) setCheck({ scope, checkedAt: Date.now(), latest });
      } catch {
        if (!cancelled) setCheck({ scope, checkedAt: Date.now(), latest: null });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [scope, deviceId, projectId, sensorKeys, lookback]);

  return useMemo(() => {
    if (!fieldMap) return null;
    const current = check?.scope === scope ? check : null;
    const readingStatus = current ? (current.latest ? null : "Sensor readings could not be checked.") : "Checking sensor readings…";
    const availability = potAvailability({
      pairings: physical,
      lastReadingAt: current?.latest ?? null,
      nowMs: current?.checkedAt ?? 0,
    });
    for (const pairing of physical) {
      const status = availability.get(pairing.name);
      const occupancy = occupiedByName.get(pairing.name);
      const reason = occupancy?.length
        ? `In use by ${occupancy.map(item => item.experimentName).join(", ")}`
        : status?.reason ?? readingStatus;
      if (status && reason) availability.set(pairing.name, { ...status, available: false, reason });
    }
    const rows = physicalPotRows(fieldMap, physical, availability);
    const ready = new Map<string, PairingRow>();
    const potNumbers = new Map<string, number>();
    for (const row of rows) {
      if (!row.pairing) continue;
      potNumbers.set(row.pairing.name, row.pot);
      if (row.ready) ready.set(row.pairing.name, row.pairing);
    }
    return { fieldMap, physical, availability, ready, potNumbers, readingStatus };
  }, [check, fieldMap, occupiedByName, physical, scope]);
}

type PickerProps = {
  model: NonNullable<ReturnType<typeof useExperimentFieldPots>>;
  selected: ReadonlySet<string>;
  onToggle: (pairing: PairingRow) => void;
  onRemove: (name: string) => void;
};

export function ExperimentPotPicker({ model, selected, onToggle, onRemove }: PickerProps) {
  const available = [...model.ready.values()].filter(pairing => !selected.has(pairing.name));
  const selectedInOrder = [...selected].sort((left, right) =>
    (model.potNumbers.get(left) ?? 101) - (model.potNumbers.get(right) ?? 101));
  return (
    <div className="experiment-builder-pot-section experiment-builder-field-picker">
      <div className="experiment-builder-section-heading">
        <h3>Pots</h3>
        <span aria-live="polite">{selected.size} selected · {available.length} available</span>
      </div>
      <PhysicalPotMap
        map={model.fieldMap}
        pairings={model.physical}
        availability={model.availability}
        selected={selected}
        onToggle={name => {
          const pairing = model.ready.get(name);
          if (pairing) onToggle(pairing);
        }}
        experimentPicker
      />
      <section aria-labelledby="available-experiment-pots">
        <h4 id="available-experiment-pots">Available</h4>
        {available.length ? (
          <div className="experiment-builder-pot-grid">
            {available.map(pairing => <button type="button" key={pairing.name} onClick={() => onToggle(pairing)}>
              <span>Pot {pairing.pot_number}</span>
            </button>)}
          </div>
        ) : <p className="settings-muted">{model.readingStatus ?? "No available pots."}</p>}
      </section>
      <section aria-labelledby="selected-experiment-pots">
        <h4 id="selected-experiment-pots">Selected</h4>
        {selectedInOrder.length ? (
          <div className="experiment-builder-pot-grid">
            {selectedInOrder.map(name => {
              const number = model.potNumbers.get(name);
              const label = number == null ? name : `Pot ${number}`;
              return <button type="button" key={name} className="is-selected" aria-label={`Remove ${label}`} onClick={() => onRemove(name)}>
                <span>{label}</span>
                {!model.ready.has(name) ? <small>Unavailable</small> : <Check size={14} aria-hidden="true" />}
              </button>;
            })}
          </div>
        ) : <p className="settings-muted">No pots selected.</p>}
      </section>
    </div>
  );
}

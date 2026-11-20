import {useEffect, useMemo, useState} from 'react';
import type {PairingRow} from '../types';
import type {PotAvailability} from './selection';
import {physicalPotRows, type FieldMapRow} from './fieldMap';
import './physicalPotMap.css';

type ExperimentMapSelection = {
  selected: ReadonlySet<number>;
  isAvailable: (pot: number) => boolean;
  occupancy: ReadonlyMap<number, string>;
  onToggle: (pot: number) => void;
};

const noPairings: readonly PairingRow[] = [];
const noAvailability = new Map<string, PotAvailability>();

export type PhysicalPotMapProps = {
  map: readonly FieldMapRow[] | null;
} & ({
  pairings: readonly PairingRow[];
  availability: ReadonlyMap<string, PotAvailability>;
  selected: ReadonlySet<string>;
  onToggle?: (name: string) => void;
  focusName?: string | null;
  states?: ReadonlyMap<string, {status?: string; detail?: string}>;
  experimentPicker?: never;
} | {
  experimentPicker: ExperimentMapSelection;
  pairings?: never;
  availability?: never;
  selected?: never;
  onToggle?: never;
  focusName?: never;
  states?: never;
});

export function PhysicalPotMap({map, pairings = noPairings, availability = noAvailability, selected, onToggle, focusName, states, experimentPicker}: PhysicalPotMapProps) {
  const [active, setActive] = useState<number | null>(experimentPicker ? null : 83);
  const rows = useMemo(() => physicalPotRows(map, pairings, availability), [map, pairings, availability]);
  useEffect(() => {
    if (!focusName) return;
    const row = rows.find(item => item.pairing?.name === focusName);
    if (row) setActive(row.pot);
  }, [focusName, rows]);
  const current = rows.find(row => row.pot === active);
  const route = current?.field?.output != null
    ? `output ${current.field.output} · 0x${current.field.relayAddress!.toString(16)}:${current.field.channel}`
    : current?.valve?.relayAddress != null ? `0x${current.valve.relayAddress.toString(16)}:${current.valve.channel}` : 'route unresolved';
  const reasonFor = (row: typeof rows[number]) => row.field?.status === 'unresolved' ? 'Route unresolved'
    : row.field?.status === 'protected' ? 'Pan’s live experiment · protected'
    : experimentPicker ? experimentPicker.occupancy.get(row.pot) ?? 'Available'
    : row.pairing ? availability.get(row.pairing.name)?.reason ?? (row.ready ? 'Ready' : 'Not ready')
    : 'Sensor not linked';
  const detail = current?.pairing && !experimentPicker && current.field?.status !== 'protected'
    ? `Sensor ${current.pairing.sensor_key || 'not linked'}${current.ready ? '' : ` · ${reasonFor(current)}`}`
    : current && reasonFor(current);
  const measured = current?.pairing ? states?.get(current.pairing.name) : null;
  return (
    <section className={`ac-physical-map${experimentPicker ? ' is-experiment-picker' : ''}`} aria-label="Physical pot map">
      <div className="ac-map-detail" aria-live="polite">
        {current ? <>
          <strong>Pot {current.pot}{experimentPicker ? '' : ` → ${route}`}</strong>
          <span>{measured?.detail || detail}</span>
        </> : <span>Choose pots on the map.</span>}
      </div>
      <div className="ac-map-grid" role="group" aria-label="Physical pots 1–100">
        {rows.map(row => {
          const unavailable = row.field?.status === 'unresolved';
          const protectedPot = row.field?.status === 'protected';
          const ready = experimentPicker ? experimentPicker.isAvailable(row.pot) : row.ready;
          const included = experimentPicker ? experimentPicker.selected.has(row.pot) : Boolean(row.pairing && selected?.has(row.pairing.name));
          const measuredState = row.pairing ? states?.get(row.pairing.name)?.status : null;
          const reason = unavailable ? 'excluded, route unresolved' : protectedPot ? 'protected, live Pan experiment'
            : experimentPicker ? reasonFor(row)
            : row.pairing ? availability.get(row.pairing.name)?.reason ?? 'ready' : 'sensor not linked';
          const output = row.field?.output != null ? `, output ${row.field.output}, 0x${row.field.relayAddress!.toString(16)}:${row.field.channel}` : '';
          return <button key={row.pot} type="button" data-pot={row.pot} className={`ac-map-pot${unavailable ? ' is-excluded' : ''}${protectedPot ? ' is-protected' : ''}${included ? ' is-selected' : ''}${row.pot === active ? ' is-inspected' : ''}${measuredState ? ` result-${measuredState}` : ''}`}
            aria-label={`Pot ${row.pot}${experimentPicker ? '' : output}, ${reason}${included ? ', selected' : ''}`} aria-pressed={included}
            aria-disabled={!ready || undefined}
            tabIndex={experimentPicker && !ready ? -1 : undefined}
            title={experimentPicker ? reasonFor(row) : undefined}
            onClick={() => {
              setActive(row.pot);
              if (!ready) return;
              if (experimentPicker) experimentPicker.onToggle(row.pot);
              else if (row.pairing) onToggle?.(row.pairing.name);
            }}>
            {row.pot}
          </button>;
        })}
      </div>
      <div className="ac-map-legend" aria-label="Map legend">
        <span><i className="is-mapped" />{experimentPicker ? 'Available' : 'Mapped'}</span>
        {map ? <span><i className="is-protected" />{experimentPicker ? 'Pan’s pots locked' : 'Pan protected'}</span> : null}
        {map ? <span><i className="is-excluded" />{experimentPicker ? 'Unavailable' : '63, 87–90 excluded'}</span> : null}
        <span><i className="is-selected" />Selected</span>
      </div>
    </section>
  );
}

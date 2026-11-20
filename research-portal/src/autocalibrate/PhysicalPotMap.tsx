import {useEffect, useMemo, useState} from 'react';
import type {PairingRow} from '../types';
import type {PotAvailability} from './selection';
import {physicalPotRows, type FieldMapRow} from './fieldMap';
import './physicalPotMap.css';

export type PhysicalPotMapProps = {
  map: readonly FieldMapRow[] | null;
  pairings: readonly PairingRow[];
  availability: ReadonlyMap<string, PotAvailability>;
  selected: ReadonlySet<string>;
  onToggle?: (name: string) => void;
  focusName?: string | null;
  states?: ReadonlyMap<string, {status?: string; detail?: string}>;
  experimentPicker?: boolean;
};

export function PhysicalPotMap({map, pairings, availability, selected, onToggle, focusName, states, experimentPicker = false}: PhysicalPotMapProps) {
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
          const included = Boolean(row.pairing && selected.has(row.pairing.name));
          const measuredState = row.pairing ? states?.get(row.pairing.name)?.status : null;
          const reason = unavailable ? 'excluded, route unresolved' : protectedPot ? 'protected, live Pan experiment'
            : row.pairing ? availability.get(row.pairing.name)?.reason ?? 'ready' : 'sensor not linked';
          const output = row.field?.output != null ? `, output ${row.field.output}, 0x${row.field.relayAddress!.toString(16)}:${row.field.channel}` : '';
          return <button key={row.pot} type="button" data-pot={row.pot} className={`ac-map-pot${unavailable ? ' is-excluded' : ''}${protectedPot ? ' is-protected' : ''}${included ? ' is-selected' : ''}${row.pot === active ? ' is-inspected' : ''}${measuredState ? ` result-${measuredState}` : ''}`}
            aria-label={`Pot ${row.pot}${experimentPicker ? '' : output}, ${reason}${included ? ', selected' : ''}`} aria-pressed={included}
            aria-disabled={!row.ready || undefined}
            tabIndex={experimentPicker && !row.ready ? -1 : undefined}
            title={experimentPicker ? reasonFor(row) : undefined}
            onClick={() => {setActive(row.pot); if (row.ready && row.pairing) onToggle?.(row.pairing.name);}}>
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

import {useEffect, useMemo, useState} from 'react';
import type {PairingRow} from '../types';
import type {PotAvailability} from './selection';
import type {FieldMapRow} from './fieldMap';
import {parseValveKey} from './workspaceContext';

export type PhysicalPotMapProps = {
  map: readonly FieldMapRow[] | null;
  pairings: readonly PairingRow[];
  availability: ReadonlyMap<string, PotAvailability>;
  selected: ReadonlySet<string>;
  onToggle?: (name: string) => void;
  focusName?: string | null;
  states?: ReadonlyMap<string, {status?: string; detail?: string}>;
};

export function PhysicalPotMap({map, pairings, availability, selected, onToggle, focusName, states}: PhysicalPotMapProps) {
  const [active, setActive] = useState(83);
  const rows = useMemo(() => Array.from({length: 100}, (_, index) => {
    const pot = index + 1;
    const field = map?.find(row => row.pot === pot);
    const owners = pairings.filter(pairing => pairing.pot_number === pot && (!field || (() => {
      const valve = parseValveKey(pairing.valve_key);
      return valve?.relayAddress === field.relayAddress && valve.channel === field.channel;
    })()));
    const pairing = owners.find(row => availability.get(row.name)?.available) ?? owners[0];
    const valve = field ?? (pairing ? parseValveKey(pairing.valve_key) : null);
    return {pot, field, pairing, valve, ready: Boolean(pairing && availability.get(pairing.name)?.available)};
  }), [map, pairings, availability]);
  useEffect(() => {
    if (!focusName) return;
    const row = rows.find(item => item.pairing?.name === focusName);
    if (row) setActive(row.pot);
  }, [focusName, rows]);
  const current = rows.find(row => row.pot === active)!;
  const route = current.field?.output != null
    ? `output ${current.field.output} · 0x${current.field.relayAddress!.toString(16)}:${current.field.channel}`
    : current.valve?.relayAddress != null ? `0x${current.valve.relayAddress.toString(16)}:${current.valve.channel}` : 'route unresolved';
  const note = current.field?.status === 'unresolved' ? 'Excluded until fixed'
    : current.field?.status === 'protected' ? 'Pan’s live experiment · protected'
      : current.pairing ? `Sensor ${current.pairing.sensor_key || 'not linked'}${current.ready ? '' : ` · ${availability.get(current.pairing.name)?.reason ?? 'Not ready'}`}`
        : 'Sensor not linked';
  const measured = current.pairing ? states?.get(current.pairing.name) : null;
  return (
    <section className="ac-physical-map" aria-label="Physical pot map">
      <div className="ac-map-detail" aria-live="polite">
        <strong>Pot {current.pot} → {route}</strong>
        <span>{measured?.detail || note}</span>
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
            aria-label={`Pot ${row.pot}${output}, ${reason}${included ? ', selected' : ''}`} aria-pressed={included}
            aria-disabled={unavailable || protectedPot || !row.ready || undefined}
            onClick={() => {setActive(row.pot); if (row.ready && !unavailable && !protectedPot) onToggle?.(row.pairing!.name);}}>
            {row.pot}
          </button>;
        })}
      </div>
      <div className="ac-map-legend" aria-label="Map legend">
        <span><i className="is-mapped" />Mapped</span>
        {map ? <span><i className="is-protected" />Pan protected</span> : null}
        {map ? <span><i className="is-excluded" />63, 87–90 excluded</span> : null}
        <span><i className="is-selected" />Selected</span>
      </div>
    </section>
  );
}

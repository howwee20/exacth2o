import {useState} from 'react';
import type {AerialModel} from '../aerialLayout';
import {configForSelection, hardLimits} from '../commissioning/orchestrator';
import type {PortalExperiment} from '../experimentRegistry';
import type {PairingRow} from '../types';
import {estimateRun, formatDuration} from './present';
import {summarizeSelection, toggleGroupSelection, toggleSelection, type PotAvailability} from './selection';
import {PhysicalPotMap} from './PhysicalPotMap';
import type {FieldMapRow} from './fieldMap';

type Props = {
  pairings: readonly PairingRow[];
  model: AerialModel;
  fieldMap: readonly FieldMapRow[] | null;
  availability: ReadonlyMap<string, PotAvailability>;
  selected: ReadonlySet<string>;
  onSelected: (next: Set<string>) => void;
  references: ReadonlySet<string>;
  onReferences: (next: Set<string>) => void;
  experiments: readonly PortalExperiment[];
  confirmedReferenceNames: readonly string[];
  readingsCheckedAt: number | null;
  checkingReadings: boolean;
  onCheckReadings: () => void;
  onInspect: (name: string) => void;
  onPrepare: () => void;
  advanced: boolean;
  onAdvanced: () => void;
  preparing: boolean;
  canPrepare: boolean;
  blockedReason: string | null;
  error: string | null;
  notice: string | null;
};

export function SelectPots(props: Props) {
  const {pairings, availability, selected, references} = props;
  const [referenceMode, setReferenceMode] = useState(false);
  const ready = pairings.filter(pairing => availability.get(pairing.name)?.available === true);
  const summary = summarizeSelection(pairings, selected, availability, references);
  const estimate = estimateRun(summary.count, configForSelection(Math.max(1, summary.count)));
  const setSelection = (next: Set<string>) => {
    props.onSelected(next);
    props.onReferences(new Set([...references].filter(name => next.has(name))));
  };
  const toggle = (name: string) => {
    if (referenceMode) {
      const next = new Set(references);
      if (next.has(name)) next.delete(name); else next.add(name);
      props.onReferences(next);
      if (!selected.has(name)) props.onSelected(new Set([...selected, name]));
    } else setSelection(toggleSelection(selected, name, availability));
  };
  const groups = props.experiments.map(experiment => ({experiment, names: experiment.pairingNames.filter(name => availability.get(name)?.available)})).filter(group => group.names.length);
  const mappedWithoutSensor = props.fieldMap?.filter(row => row.status === 'verified' && !pairings.some(pairing => pairing.pot_number === row.pot)).length ?? 0;
  return <section className="ac-selection" aria-labelledby="ac-select-title">
    <h3 id="ac-select-title">Choose pots</h3>
    <PhysicalPotMap map={props.fieldMap} pairings={pairings} availability={availability} selected={selected} onToggle={toggle} />
    <div className="ac-toolbar" role="toolbar" aria-label="Selection">
      <button type="button" className="settings-secondary-button" onClick={() => setSelection(new Set(ready.map(pairing => pairing.name)))} disabled={!ready.length}>Select all ready ({ready.length})</button>
      <button type="button" className="settings-secondary-button" onClick={() => setSelection(new Set())} disabled={!selected.size}>Clear</button>
      <button type="button" className="ac-link" onClick={props.onCheckReadings} disabled={props.checkingReadings}>{props.checkingReadings ? 'Checking sensors…' : 'Refresh sensors'}</button>
    </div>
    {mappedWithoutSensor > 0 ? <p className="settings-muted ac-small">{mappedWithoutSensor} mapped pots need a sensor link before they can run.</p> : null}
    <details className="ac-options">
      <summary>Selection options</summary>
      <div className="ac-toolbar">
        <button type="button" className="ac-link" onClick={props.onAdvanced}>{props.advanced ? "Use simple Run" : "Advanced setup"}</button>
        {groups.map(({experiment, names}) => <button key={experiment.id} type="button" className="settings-secondary-button" onClick={() => setSelection(toggleGroupSelection(selected, names, availability))}>{experiment.name}</button>)}
        <button type="button" className="settings-secondary-button" aria-pressed={referenceMode} onClick={() => setReferenceMode(value => !value)}>{referenceMode ? 'Done marking references' : 'Mark references'}</button>
        {props.confirmedReferenceNames.length ? <button type="button" className="settings-secondary-button" onClick={() => {
          const names = props.confirmedReferenceNames.filter(name => availability.get(name)?.available);
          props.onSelected(new Set([...selected, ...names])); props.onReferences(new Set([...references, ...names]));
        }}>Use saved references</button> : null}
      </div>
    </details>
    <div className="ac-selection-footer">
      <div aria-live="polite"><strong>{summary.count} selected</strong>{summary.count ? <span> · about {formatDuration(estimate.typicalMinutes)}</span> : null}</div>
      <button type="button" className="settings-primary-button" onClick={props.onPrepare} disabled={!props.canPrepare || props.preparing || summary.count < hardLimits.minPots}>{props.preparing ? 'Saving selection…' : props.advanced ? 'Continue' : 'Run'}</button>
    </div>
    {props.blockedReason ? <p className="settings-error-line">{props.blockedReason}</p> : null}
    {props.notice ? <p className="ac-notice" role="status">{props.notice}</p> : null}
    {props.error ? <p className="settings-error-line" role="alert">{props.error}</p> : null}
  </section>;
}

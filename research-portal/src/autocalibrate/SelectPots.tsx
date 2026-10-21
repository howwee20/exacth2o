import { useMemo, useState } from "react";
import { Star } from "lucide-react";
import type { AerialModel } from "../aerialLayout";
import { configForSelection, hardLimits, singlePotLimitation } from "../commissioning/orchestrator";
import type { PortalExperiment } from "../experimentRegistry";
import { AerialBench } from "../product/AerialBench";
import { StatusChip } from "../SettingsChrome";
import type { PairingRow } from "../types";
import { estimateRun, formatClock, formatDuration, potName, selectionStates } from "./present";
import { summarizeSelection, toggleGroupSelection, toggleSelection, type PotAvailability } from "./selection";

type Props = {
  pairings: readonly PairingRow[];
  model: AerialModel;
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
  onInspect: (pairingName: string) => void;
  onPrepare: () => void;
  preparing: boolean;
  canPrepare: boolean;
  blockedReason: string | null;
  error: string | null;
  notice: string | null;
};

/** Step 1: choose pots on the overhead view of the bench. */
export function SelectPots(props: Props) {
  const { pairings, model, availability, selected, references } = props;
  const [referenceMode, setReferenceMode] = useState(false);
  const states = useMemo(() => selectionStates(pairings, availability, references), [pairings, availability, references]);
  const summary = summarizeSelection(pairings, selected, availability, references);
  const unavailable = pairings.filter((pairing) => availability.get(pairing.name)?.available === false);
  const available = pairings.filter((pairing) => availability.get(pairing.name)?.available !== false);
  const config = configForSelection(Math.max(1, summary.count));
  const estimate = estimateRun(summary.count, config);
  const experimentChoices = props.experiments
    .map((experiment) => ({ experiment, names: experiment.pairingNames.filter((name) => availability.has(name)) }))
    .filter((item) => item.names.length > 0);
  const confirmed = props.confirmedReferenceNames.filter((name) => availability.get(name)?.available !== false);

  const toggle = (name: string) => {
    if (referenceMode) {
      const next = new Set(references);
      if (next.has(name)) next.delete(name);
      else if (availability.get(name)?.available !== false) {
        next.add(name);
        if (!selected.has(name)) props.onSelected(new Set([...selected, name]));
      }
      props.onReferences(next);
      return;
    }
    const next = toggleSelection(selected, name, availability);
    props.onSelected(next);
    // A pot that is no longer selected cannot be a reference.
    if (!next.has(name) && references.has(name)) {
      const refs = new Set(references);
      refs.delete(name);
      props.onReferences(refs);
    }
  };
  const setSelection = (next: Set<string>) => {
    props.onSelected(next);
    props.onReferences(new Set([...references].filter((name) => next.has(name))));
  };

  const tooFew = summary.count > 0 && summary.count < hardLimits.minPots;

  return (
    <section className="settings-card ac-step" aria-labelledby="ac-select-title">
      <div className="settings-card-head">
        <h3 id="ac-select-title">Choose pots</h3>
        <StatusChip tone={summary.count >= hardLimits.minPots ? "ok" : "unknown"}>{summary.count} of {summary.total} selected</StatusChip>
      </div>
      <p className="settings-muted">
        Tap pots, a zone, or select all {available.length}. Every selected valve is tested one at a time and watched on every selected sensor,
        so a crossed hose is found wherever it leads inside the selection.
      </p>

      <div className="ac-toolbar" role="toolbar" aria-label="Selection">
        <button type="button" className="settings-secondary-button" onClick={() => setSelection(new Set(available.map((pairing) => pairing.name)))} disabled={!available.length}>
          Select all {available.length}
        </button>
        <button type="button" className="settings-secondary-button" onClick={() => setSelection(new Set())} disabled={!summary.count}>Clear</button>
        {experimentChoices.map(({ experiment, names }) => (
          <button key={experiment.id} type="button" className="settings-secondary-button" onClick={() => setSelection(toggleGroupSelection(selected, names, availability))}>
            {names.every((name) => selected.has(name) || availability.get(name)?.available === false) ? "Clear" : "Select"} {experiment.name} ({names.length})
          </button>
        ))}
        <button type="button" className={`settings-secondary-button${referenceMode ? " is-active" : ""}`} aria-pressed={referenceMode} onClick={() => setReferenceMode((value) => !value)}>
          <Star size={14} aria-hidden="true" /> {referenceMode ? "Done marking references" : "Mark known-correct references"}
        </button>
        {confirmed.length ? (
          <button type="button" className="settings-secondary-button" onClick={() => {
            props.onSelected(new Set([...selected, ...confirmed]));
            props.onReferences(new Set([...references, ...confirmed]));
          }}>
            Use {confirmed.length} bench-confirmed pot{confirmed.length === 1 ? "" : "s"} as references
          </button>
        ) : null}
      </div>
      {referenceMode ? (
        <p className="ac-mode-note" role="status">
          Reference mode: tap pots whose valve you know is correct (for example pots checked at the bench). They are tested like the others and act as
          positive controls; if one comes out differently, the run's other results are flagged.
        </p>
      ) : null}

      <AerialBench
        model={model}
        states={states}
        selected={selected}
        selectable
        onToggle={toggle}
        onToggleZone={referenceMode ? undefined : (zone) => setSelection(toggleGroupSelection(selected, pairings.filter((pairing) => pairing.zone === zone).map((pairing) => pairing.name), availability))}
        onInspect={props.onInspect}
        label={`Installation seen from above: ${summary.total} pots, ${summary.count} selected`}
      />
      <ul className="ac-legend" aria-label="Legend">
        <li><span className="ac-key is-selected" aria-hidden="true" />Selected</li>
        <li><span className="ac-key is-unavailable" aria-hidden="true" />Cannot take part (reason on the pot)</li>
        <li><span className="ac-key-star" aria-hidden="true">★</span>Known-correct reference</li>
        <li>{model.basis === "recorded" ? `Positions from the recorded bench layout${model.version ? ` (version ${model.version})` : ""}.` : "Schematic arrangement by zone and pot number, as in the PicoGrid overview; not measured positions."}</li>
        <li className="ac-legend-keys">Keyboard: arrow keys move, Space selects, I opens a pot's details.</li>
      </ul>

      {model.unplaced.length ? (
        <div className="ac-unplaced">
          <h4>Not on the overhead view ({model.unplaced.length})</h4>
          <p className="settings-muted">{model.unplacedReason}</p>
          <div className="ac-chip-grid">
            {model.unplaced.map((pairing) => {
              const state = availability.get(pairing.name);
              const isSelected = selected.has(pairing.name);
              return (
                <button key={pairing.name} type="button" className={`ac-pot-chip${isSelected ? " is-selected" : ""}`} aria-pressed={isSelected}
                  aria-disabled={state?.available === false ? true : undefined} title={state?.reason}
                  onClick={() => { if (state?.available !== false) toggle(pairing.name); }}>
                  {potName(pairing.pot_number, pairing.name)}{references.has(pairing.name) ? " ★" : ""}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {unavailable.length ? (
        <details className="ac-unavailable">
          <summary>{unavailable.length} pot{unavailable.length === 1 ? "" : "s"} cannot take part right now</summary>
          <ul>
            {unavailable.map((pairing) => (
              <li key={pairing.name}>
                <button type="button" className="ac-link" onClick={() => props.onInspect(pairing.name)}>{potName(pairing.pot_number, pairing.name)}</button>
                <span>{availability.get(pairing.name)?.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="ac-summary" aria-live="polite">
        <div>
          <strong>{summary.count ? `${summary.count} pot${summary.count === 1 ? "" : "s"} selected` : "No pots selected"}</strong>
          {summary.count ? <span className="ac-summary-pots">Pots {summary.potRanges}</span> : null}
          <span className="ac-summary-zones">
            {summary.zones.map((zone) => <span key={zone.zone}>Zone {zone.zone}: {zone.selected}/{zone.total}</span>)}
          </span>
          {summary.references ? <span>{summary.references} reference{summary.references === 1 ? "" : "s"}</span> : null}
        </div>
        {summary.count >= hardLimits.minPots ? (
          <p className="settings-muted">
            About {formatDuration(estimate.typicalMinutes)} once the pots are prepared (up to {formatDuration(estimate.worstMinutes)} if every valve needs its one retry).
            The run is driven by this browser tab: it continues while you use other pages, and stops before its next pulse if the tab closes. It can be resumed from its saved evidence.
          </p>
        ) : null}
        {summary.count === 1 ? <p className="settings-error-line">{singlePotLimitation}</p> : null}
        {tooFew && summary.count !== 1 ? <p className="settings-error-line">Select at least {hardLimits.minPots} pots.</p> : null}
        {summary.count > 0 && summary.count < summary.available ? (
          <p className="settings-muted">
            Only the selected pots are watched. A selected valve that waters an unselected pot shows as “no response”, and a selected pot watered from outside the
            selection shows as “not reached by any selected valve”. Select whole zones, or all {summary.available}, to find every crossing.
          </p>
        ) : null}
        <p className="settings-muted ac-small">
          Readings {props.readingsCheckedAt ? `checked at ${formatClock(props.readingsCheckedAt)}` : "not checked yet"} ·{" "}
          <button type="button" className="ac-link" onClick={props.onCheckReadings} disabled={props.checkingReadings}>{props.checkingReadings ? "Checking…" : "Check again"}</button>
        </p>
      </div>

      {props.notice ? <p className="ac-notice" role="status">{props.notice}</p> : null}
      {props.error ? <p className="settings-error-line" role="alert">{props.error}</p> : null}
      <div className="ac-actions">
        <button type="button" className="settings-primary-button" onClick={props.onPrepare} disabled={!props.canPrepare || props.preparing || summary.count < hardLimits.minPots}>
          {props.preparing ? "Recording original settings…" : `Continue with ${summary.count} pot${summary.count === 1 ? "" : "s"}`}
        </button>
        {props.blockedReason ? <p className="settings-muted">{props.blockedReason}</p> : (
          <p className="settings-muted">Next: the server records every selected pot's current settings, then you review one change that turns their automatic watering off for the run.</p>
        )}
      </div>
    </section>
  );
}

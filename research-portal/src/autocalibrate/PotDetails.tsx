import { useEffect, useId, useRef } from "react";
import { Droplets, X } from "lucide-react";
import type { PotBinding } from "../benchClient";
import type { PotSettingsSnapshot } from "../commissioning/topologyPlan";
import type { ProposedMapping, PulseEvidence, UnresolvedValve } from "../commissioning/types";
import type { PairingRow } from "../types";
import { faultAdvice, faultText, formatClock, potName } from "./present";
import type { PotAvailability } from "./selection";
import { valveLabel } from "./workspaceContext";

const bindingText: Record<string, string> = {
  software_only: "Software only: not yet confirmed at the bench",
  researcher_confirmed: "Confirmed at the bench by a researcher",
  delivery_verified: "Delivery verified",
};

function settings(pairing: Pick<PairingRow, "wtc_percent_limit" | "valve_open_time_ms" | "measurement_interval_ms">) {
  const on = pairing.wtc_percent_limit >= 0 && pairing.wtc_percent_limit <= 100 && pairing.valve_open_time_ms > 0;
  return `${on ? `target ${pairing.wtc_percent_limit}%, ${Math.round(pairing.valve_open_time_ms / 100) / 10} s pulses` : "automatic watering off"}, every ${Math.round(pairing.measurement_interval_ms / 1000)} s`;
}

/** One pot's identities, settings and evidence, opened from the aerial view. */
export function PotDetails(props: {
  pairing: PairingRow;
  onClose: () => void;
  availability?: PotAvailability;
  binding?: PotBinding;
  original?: PotSettingsSnapshot;
  evidence: readonly PulseEvidence[];
  proposal?: ProposedMapping;
  intoProposal?: ProposedMapping;
  unresolved?: UnresolvedValve;
  potForSensor: ReadonlyMap<string, number | null>;
  onOpenOutput?: (valveKey: string) => void;
  runInProgress: boolean;
}) {
  const { pairing } = props;
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, [pairing.name]);
  const own = props.evidence.filter((item) => item.valveKey === pairing.valve_key);
  const raisedBy = props.evidence.filter((item) => !item.invalidated && item.responses.some((response) => response.detected && response.sensorKey === pairing.sensor_key));
  const name = potName(pairing.pot_number, pairing.name);
  return (
    <aside className="ac-details" role="dialog" aria-modal="false" aria-labelledby={titleId} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); props.onClose(); } }}>
      <div className="ac-details-head">
        <h4 id={titleId}>{name} <span className="settings-muted">· zone {pairing.zone}</span></h4>
        <button ref={closeRef} type="button" className="ac-icon-button" onClick={props.onClose} aria-label={`Close ${name} details`}><X size={16} aria-hidden="true" /></button>
      </div>
      <dl className="ac-details-facts">
        <div><dt>Pairing</dt><dd>{pairing.name}</dd></div>
        <div><dt>Sensor</dt><dd><code className="settings-identity">{pairing.sensor_key || "none"}</code></dd></div>
        <div><dt>Valve</dt><dd><code className="settings-identity">{pairing.valve_key ? valveLabel(pairing.valve_key) : "none"}</code></dd></div>
        <div><dt>Now</dt><dd>{settings(pairing)}</dd></div>
        {props.original ? <div><dt>Recorded before</dt><dd>{settings({ wtc_percent_limit: props.original.wtcPercentLimit, valve_open_time_ms: props.original.valveOpenTimeMs, measurement_interval_ms: props.original.measurementIntervalMs })}</dd></div> : null}
        {props.binding ? <div><dt>Bench status</dt><dd>{bindingText[props.binding.physicalStatus] ?? props.binding.physicalStatus}</dd></div> : null}
      </dl>
      {props.availability?.reason ? <p className="settings-error-line">{props.availability.reason}</p> : null}
      {props.availability?.notes.length ? <ul className="ac-notes">{props.availability.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
      {props.proposal ? (
        <div className="ac-details-block">
          <strong>Its valve ({valveLabel(pairing.valve_key)})</strong>
          <p>{props.proposal.matchesRecord ? "Raised this pot's own sensor." : `Raised ${props.potForSensor.get(props.proposal.proposedSensorKey) != null ? `pot ${props.potForSensor.get(props.proposal.proposedSensorKey)}` : props.proposal.proposedSensorKey} instead.`}
            {" "}+{props.proposal.deltaVwc.toFixed(1)}% VWC after {props.proposal.pulseSeconds} s · confidence {Math.round(props.proposal.confidence * 100)}%</p>
          {props.proposal.faults.length ? <p className="settings-muted">{props.proposal.faults.map((fault) => `${faultText[fault] ?? fault}: ${faultAdvice[fault] ?? ""}`).join(" ")}</p> : null}
        </div>
      ) : null}
      {props.intoProposal && props.intoProposal.valveKey !== pairing.valve_key ? (
        <div className="ac-details-block"><strong>What waters this pot</strong><p>Valve {valveLabel(props.intoProposal.valveKey)} raised its sensor (+{props.intoProposal.deltaVwc.toFixed(1)}% VWC).</p></div>
      ) : null}
      {props.unresolved ? (
        <div className="ac-details-block"><strong>{faultText[props.unresolved.reason] ?? props.unresolved.reason}</strong><p>{props.unresolved.detail}</p><p className="settings-muted">{faultAdvice[props.unresolved.reason] ?? ""}</p></div>
      ) : null}
      {own.length ? (
        <div className="ac-details-block">
          <strong>Pulses on its valve</strong>
          <ul className="commission-plain">
            {own.map((item) => {
              const top = item.responses.filter((response) => response.detected).sort((a, b) => b.deltaVwc - a.deltaVwc).slice(0, 3);
              return (
                <li key={`${item.step}:${item.requestedAt}`}>
                  <span>{formatClock(item.requestedAt)} · {item.requestedSeconds} s{item.escalated ? " retry" : ""} · controller {item.acknowledgement.status.replace("_", " ")} ·{" "}
                    {item.invalidated ? `set aside (${item.invalidated.reason})` : top.length ? top.map((response) => `${props.potForSensor.get(response.sensorKey) != null ? `pot ${props.potForSensor.get(response.sensorKey)}` : response.sensorKey} +${response.deltaVwc.toFixed(1)}%`).join(", ") : "nothing rose"}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {raisedBy.length ? (
        <p className="settings-muted">Its sensor rose after: {raisedBy.map((item) => valveLabel(item.valveKey)).join(", ")}.</p>
      ) : null}
      {props.onOpenOutput && pairing.valve_key ? (
        <button type="button" className="settings-secondary-button" onClick={() => props.onOpenOutput?.(pairing.valve_key)}>
          <Droplets size={14} aria-hidden="true" /> Open this valve by hand (troubleshooting)
        </button>
      ) : null}
      {props.runInProgress ? <p className="settings-muted ac-small">Holding a valve by hand stops the autocalibration run first; its evidence is kept.</p> : null}
    </aside>
  );
}

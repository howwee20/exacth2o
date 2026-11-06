import type { PulseEvidence } from "../commissioning/types";
import { formatClock, potName } from "./present";
import { valveLabel } from "./workspaceContext";

/**
 * The technical evidence: per pulse, what was requested, what the controller
 * acknowledged, and what the sensors measured. Three separate facts; none of them
 * proves that water physically reached a pot.
 */
export function EvidenceTable({ evidence, potForSensor, potByValve, limit = 400 }: {
  evidence: readonly PulseEvidence[];
  potForSensor: ReadonlyMap<string, number | null>;
  potByValve: ReadonlyMap<string, { pairingName: string; potNumber: number | null }>;
  limit?: number;
}) {
  if (!evidence.length) return <p className="settings-muted">No valve has been tested yet.</p>;
  const rows = evidence.slice(-limit);
  return (
    <div className="settings-table-wrap is-scrollable">
      <table className="settings-table commission-table ac-evidence-table">
        <thead>
          <tr>
            <th scope="col">Valve (recorded pot)</th>
            <th scope="col">Requested</th>
            <th scope="col">Controller</th>
            <th scope="col">Sensors that rose</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const owner = potByValve.get(item.valveKey);
            const responders = item.responses.filter((response) => response.detected).sort((a, b) => b.deltaVwc - a.deltaVwc);
            return (
              <tr key={`${item.step}:${item.requestedAt}`} className={item.invalidated ? "is-set-aside" : ""}>
                <td>
                  <code className="settings-identity">{valveLabel(item.valveKey)}</code>
                  <span className="commission-subtle">{owner ? potName(owner.potNumber, owner.pairingName) : item.pairingName}{item.escalated ? " · retry" : ""}{item.segment && item.segment > 1 ? ` · segment ${item.segment}` : ""}</span>
                </td>
                <td>{item.acknowledgement.status === "not_sent" && !item.commandId ? `Not sent (rehearsal, ${item.requestedSeconds} s)` : `${item.requestedSeconds} s at ${formatClock(item.requestedAt)}`}</td>
                <td>
                  {item.acknowledgement.status === "not_sent" ? (item.commandId ? "Waiting…" : "—")
                    : item.acknowledgement.status === "succeeded" ? `Acknowledged ${formatClock(item.acknowledgement.at)}` : `Reported ${item.acknowledgement.status}`}
                  {item.acknowledgement.error ? <span className="commission-subtle">{item.acknowledgement.error}</span> : null}
                </td>
                <td>
                  {item.invalidated ? <span className="commission-subtle">Set aside: {item.invalidated.reason}</span> : null}
                  {responders.length
                    ? responders.slice(0, 4).map((response) => {
                      const pot = potForSensor.get(response.sensorKey);
                      return <span key={response.sensorKey} className="commission-response">{pot != null ? `Pot ${pot}` : response.sensorKey} +{response.deltaVwc.toFixed(1)}% VWC (z {response.z.toFixed(0)})</span>;
                    })
                    : <span className="settings-empty-value">{item.responses.length ? "No selected sensor rose" : "Waiting for readings"}</span>}
                  <span className="commission-subtle">{item.responses.length} sensors read over {item.observedSeconds} s</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {evidence.length > limit ? <p className="settings-muted">Showing the latest {limit} of {evidence.length} pulses. Download the record for all of them.</p> : null}
    </div>
  );
}

import type { PortalExperimentAssignment } from "../experimentRegistry";
import { formatMeasurementTime } from "../measurementFreshness";
import { vwcQuality } from "../readingQuality";
import type { PairingRow, SensorReading, ValveEvent } from "../types";

export function ReadingEvidence({ pairing, reading, assignment, valveEvents }: {
  pairing: PairingRow;
  reading: SensorReading | null;
  assignment?: PortalExperimentAssignment | null;
  valveEvents: readonly ValveEvent[];
}) {
  const issue = vwcQuality(reading?.calibrated_value);
  const at = reading ? Date.parse(reading.device_recorded_at) : null;
  const recent = valveEvents.filter((event) => event.action === "open" && at != null && Date.parse(event.device_recorded_at) <= at)
    .sort((a, b) => Date.parse(b.device_recorded_at) - Date.parse(a.device_recorded_at)).slice(0, 3);
  return <details className="px-card px-evidence" id="reading-evidence">
    <summary>Explain this reading</summary>
    {issue ? <p className="px-notice">{issue}. Review the raw signal, sensor placement, and calibration. The original value is retained.</p> : null}
    <dl className="px-facts">
      <div><dt>Measured</dt><dd>{at ? formatMeasurementTime(at) : "No reading loaded"}</dd></div>
      <div><dt>Raw sensor output</dt><dd>{reading?.raw_value ?? "Not recorded"}</dd></div>
      <div><dt>Recorded VWC</dt><dd>{reading ? `${reading.calibrated_value}%` : "Not recorded"}</dd></div>
      <div><dt>Sensor on this reading</dt><dd className="px-mono">{reading?.sensor_key ?? "Not recorded"}</dd></div>
      <div><dt>Received by portal</dt><dd>{reading ? formatMeasurementTime(Date.parse(reading.server_received_at)) : "Not recorded"}</dd></div>
      <div><dt>Current calibration</dt><dd>{pairing.calibration_name || pairing.calibration_label || pairing.calibration || "Not recorded"}</dd></div>
      <div><dt>Target in current plan</dt><dd>{assignment?.target_vwc_percent == null ? "Not set" : `${assignment.target_vwc_percent}% VWC`}</dd></div>
    </dl>
    <p className="px-muted px-small">The reading stores its raw and calibrated values. The calibration and target above describe the current setup; consult the experiment Record for changes at an earlier time.</p>
    <h3 className="px-section-label">Valve records before this reading</h3>
    {recent.length ? <ul>{recent.map((event) => <li key={event.event_id}>{formatMeasurementTime(Date.parse(event.device_recorded_at))}{event.duration_ms != null ? ` · ${(event.duration_ms / 1000).toFixed(1)} seconds` : ""}</li>)}</ul> : <p className="px-muted">No earlier opening in the loaded window.</p>}
    <p className="px-muted px-small">Valve records describe controller actions, not measured water delivery. Field notes appear below.</p>
  </details>;
}

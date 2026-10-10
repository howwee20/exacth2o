import { defaultGrouping, experimentFactors, levelLabel, potGroups } from "./experimentFactors";
import { readingsForExperiment, type PortalExperiment } from "./experimentRegistry";
import { csvEscape, dedupeReadingsForExport } from "./readingsExport";
import { vwcQuality } from "./readingQuality";
import type { RecordItem } from "./recordModel";
import { decimateForDisplay } from "./seriesStatistics";
import type { PairingRow, SensorReading } from "./types";
import { potTraces } from "./waterline";

export type ExperimentReportInput = {
  experiment: PortalExperiment;
  pairings: readonly PairingRow[];
  readings: readonly SensorReading[];
  events: readonly RecordItem[];
  problems: readonly string[];
  startMs: number;
  endMs: number;
  generatedAt: number;
  source: string;
};

export function reportReadings(input: Pick<ExperimentReportInput, "experiment" | "readings" | "startMs" | "endMs">) {
  return dedupeReadingsForExport(readingsForExperiment([...input.readings], input.experiment)
    .filter((reading) => { const at = Date.parse(reading.device_recorded_at); return at >= input.startMs && at <= input.endMs; }));
}

const html = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[character]!));
const utc = (ms: number) => Number.isFinite(ms) ? new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "Not recorded";
const cell = (value: unknown) => csvEscape(typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

/** Metadata is explicitly a plan snapshot, not an assertion about historical calibration. */
export function experimentReadingsCsv(input: ExperimentReportInput) {
  const assignments = new Map(input.experiment.assignments?.map((item) => [item.pairing_name, item]));
  const headers = ["experiment", "plan_snapshot_revision", "pairing_name", "crop_in_plan", "treatment_in_plan", "block_in_plan", "target_vwc_in_plan", "sensor_key", "device_recorded_at_utc", "server_received_at_utc", "calibrated_vwc_percent", "raw_sensor_output", "temperature_c", "electrical_conductivity", "quality_note", "event_id"];
  const rows = reportReadings(input).map((reading) => {
    const plan = assignments.get(reading.pairing_name);
    return [input.experiment.name, input.experiment.currentVersion ?? "", reading.pairing_name, plan?.crop, plan?.treatment, plan?.block, plan?.target_vwc_percent, reading.sensor_key, reading.device_recorded_at, reading.server_received_at, reading.calibrated_value, reading.raw_value, reading.temperature, reading.electrical_conductivity, vwcQuality(reading.calibrated_value) ?? "", reading.event_id].map(cell).join(",");
  });
  return [headers.join(","), ...rows].join("\r\n");
}

function chart(input: ExperimentReportInput, readings: SensorReading[]) {
  const groups = potGroups(input.experiment, defaultGrouping(experimentFactors(input.experiment)));
  const traces = potTraces(readings, input.pairings, "vwc");
  const values = [...traces.values()].flatMap((trace) => trace.points.map((point) => point.value));
  if (!values.length) return '<p class="notice">No readings in this reporting window.</p>';
  const minimum = values.reduce((value, next) => Math.min(value, next), Infinity), maximum = values.reduce((value, next) => Math.max(value, next), -Infinity);
  const pad = Math.max(2, (maximum - minimum) * .12), low = minimum - pad, high = maximum + pad;
  const x = (at: number) => 54 + (at - input.startMs) / Math.max(1, input.endMs - input.startMs) * 850;
  const y = (value: number) => 242 - (value - low) / (high - low) * 220;
  const lines = groups.flatMap((group) => group.pairingNames.flatMap((name) => {
    const trace = traces.get(name); if (!trace) return [];
    return decimateForDisplay(trace.points, {startMs: input.startMs, endMs: input.endMs, buckets: 500, gapMs: trace.gapMs}).map((points) => `<polyline points="${points.map((point) => `${x(point.timestampMs).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ")}" stroke="${group.pattern.color}" fill="none" stroke-width="1.5" opacity=".7"/>`);
  })).join("");
  const ticks = [0,.25,.5,.75,1].map((fraction) => { const value = low + (high-low)*fraction; return `<line x1="54" x2="904" y1="${y(value)}" y2="${y(value)}" stroke="#dbe3df"/><text x="46" y="${y(value)+4}" text-anchor="end">${value.toFixed(1)}</text>`; }).join("");
  return `<svg viewBox="0 0 930 282" role="img" aria-label="Individual pot VWC readings in the reporting window"><text x="54" y="13">VWC %</text>${ticks}${lines}<text x="54" y="273">${html(utc(input.startMs))}</text><text x="904" y="273" text-anchor="end">${html(utc(input.endMs))}</text></svg><p class="legend">${groups.map((group) => `<span><i style="background:${group.pattern.color}"></i>${html(group.label)}</span>`).join(" ")}</p><p class="muted">Each line is one pot. Lines break across missing intervals. Values are preserved as recorded.</p>`;
}

export function experimentBriefHtml(input: ExperimentReportInput) {
  const { experiment } = input;
  const readings = reportReadings(input);
  const pairs = new Map(input.pairings.map((pairing) => [pairing.name, pairing]));
  const traces = potTraces(readings, input.pairings, "vwc");
  const qualityCount = readings.filter((reading) => vwcQuality(reading.calibrated_value)).length;
  const rows = experiment.pairingNames.map((name) => {
    const assignment = experiment.assignments?.find((item) => item.pairing_name === name);
    const points = traces.get(name)?.points ?? [];
    const last = points.at(-1);
    return `<tr><td>${html(pairs.get(name)?.pot_number ?? name)}</td><td>${html(levelLabel(assignment?.crop ?? ""))}</td><td>${html(levelLabel(assignment?.treatment ?? ""))}</td><td>${html(assignment?.block ?? "—")}</td><td>${assignment?.target_vwc_percent == null ? "—" : html(assignment.target_vwc_percent)+"%"}</td><td>${last ? last.value.toFixed(1)+"%" : "No reading"}${vwcQuality(last?.value) ? '<br><span class="quality">Review calibration</span>' : ""}</td><td>${points.length}</td></tr>`;
  }).join("");
  const events = input.events.filter((event) => event.happenedAt >= input.startMs && event.happenedAt <= input.endMs).slice().sort((a,b) => a.happenedAt-b.happenedAt);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(experiment.name)} · Experiment brief</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f7f9f8;color:#172a23;font:15px/1.55 system-ui,sans-serif}main{max-width:980px;margin:40px auto;padding:36px;background:white}header{border-bottom:2px solid #176449;padding-bottom:22px}h1{font-size:32px;line-height:1.15;letter-spacing:-.03em}h2{margin-top:32px;font-size:19px}h3{font-size:15px;margin-bottom:3px}p{margin:8px 0}.brand{font-weight:700;color:#176449}.muted,small{color:#53665d}.meta{display:flex;gap:24px;flex-wrap:wrap}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:9px 6px;text-align:left;border-bottom:1px solid #dbe3df;vertical-align:top}th{font-weight:600}.notice{padding:12px;background:#f8f3e8;border-left:3px solid #996324}.quality{color:#805414}svg{width:100%;font:11px system-ui}.legend{display:flex;gap:16px;flex-wrap:wrap}.legend i{display:inline-block;width:16px;height:3px;margin-right:6px}li{margin:10px 0}.events{padding-left:20px}footer{border-top:1px solid #dbe3df;margin-top:30px;padding-top:16px;font-size:12px} @media(max-width:640px){main{margin:0;padding:20px}table{font-size:11px}td,th{padding:6px 3px}h1{font-size:26px}}@media print{body{background:white}main{margin:0;padding:0;max-width:none}h2,h3{break-after:avoid}tr,li{break-inside:avoid}a{color:inherit}}
  </style></head><body><main><header><div class="brand">ExactH2O / Experiment brief</div><h1>${html(experiment.name)}</h1><p>${html(experiment.shortDescription)}</p><div class="meta"><span>${experiment.pairingNames.length} pots</span><span>${html(levelLabel(experiment.mode))}</span><span>${html(experiment.status?.replace(/_/g," ") ?? "State not recorded")}</span><span>Plan revision ${html(experiment.currentVersion ?? "not recorded")}</span></div></header>
  <h2>Reporting window</h2><p>${html(utc(input.startMs))} to ${html(utc(input.endMs))}</p><p class="muted">${readings.length.toLocaleString()} loaded readings · ${html(input.source)}. This brief covers the selected window, not necessarily the complete experiment.</p>
  ${input.problems.map((problem) => `<p class="notice">${html(problem)}</p>`).join("")}${qualityCount ? `<p class="notice">${qualityCount} recorded VWC values need review. Raw and calibrated readings are retained in the CSV.</p>` : ""}
  <h2>Moisture history</h2>${chart(input,readings)}
  <h2>Plan snapshot and latest readings</h2><p class="muted">Assignments and targets are from plan revision ${html(experiment.currentVersion ?? "not recorded")}. They do not establish the controller target or calibration at every historical reading.</p><table><thead><tr><th>Pot</th><th>Crop</th><th>Treatment</th><th>Block</th><th>Plan target</th><th>Last VWC</th><th>Readings</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Experiment record</h2>${events.length ? `<ol class="events">${events.map((event) => `<li><small>${html(utc(event.happenedAt))} · ${html(event.kind)} · ${html(event.basis)}</small><h3>${html(event.title)}</h3>${event.detail ? `<p>${html(event.detail)}</p>` : ""}</li>`).join("")}</ol>` : '<p>No record entries were available for this window.</p>'}
  <footer><p>Generated ${html(utc(input.generatedAt))}. All timestamps use UTC. VWC is volumetric water content. The accompanying CSV retains measurement and receipt times, raw values, and event identifiers.</p><p>Valve openings are controller records, not measurements of delivered water. Calibration changes, missing sources, and reading gaps should be considered when interpreting the experiment.</p></footer></main></body></html>`;
}

export function downloadReportFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { healthNumber, healthRecord, healthString, healthTimestampMs } from "../healthValues";
import { measurementFreshness } from "../measurementFreshness";

type Counts = { current: number; total: number };
const nodeNames: Record<string, string> = { D30GQN2D: "Node4", D30GQN2E: "Node2" };

function countRow(counts: Map<string, Counts>, label: string, current: boolean) {
  const count = counts.get(label) ?? { current: 0, total: 0 };
  count.total++;
  if (current) count.current++;
  counts.set(label, count);
}

/** The controller's pairing inventory covers all configured groups. Its compact history can cover a smaller map. */
export function pairingReport(rawHealth: unknown, atMs: number) {
  const api = healthRecord(healthRecord(rawHealth).api);
  const inventory = healthRecord(api.pairings);
  const readings = healthRecord(api.pairingReadings);
  if (readings.ok !== true || !Array.isArray(readings.rows) || inventory.ok === false ||
      healthRecord(api.readings).ok === false) return null;
  const expected = healthNumber(inventory.count);
  if (expected !== null && expected !== readings.rows.length) return null;
  const groups = new Map<string, Counts>();
  const nodes = new Map<string, Counts>();
  const review: { name: string; reason: string }[] = [];
  let latest = -Infinity;
  for (const entry of readings.rows) {
    const row = healthRecord(entry);
    const name = healthString(row.actualName) ?? healthString(row.softwarePairing);
    if (!name) return null;
    const timestamp = healthTimestampMs(healthRecord(row.latestReading).createdAt);
    const freshness = measurementFreshness({ measuredAt: timestamp, expectedIntervalMs: healthNumber(row.MeasurementInterval), nowMs: atMs });
    const current = row.ok !== false && freshness.state === "current";
    if (timestamp !== null && freshness.state !== "unknown") latest = Math.max(latest, timestamp);
    if (!current) {
      const reason = row.ok === false ? "Incomplete pairing" : timestamp === null ? "No reading in report" : freshness.label;
      review.push({ name, reason });
    }
    countRow(groups, healthString(row.groupName) ?? "Ungrouped", current);
    const board = healthString(row.actualSensor)?.split(":")[0];
    if (board) countRow(nodes, nodeNames[board] ?? board, current);
  }
  return { total: readings.rows.length, current: readings.rows.length - review.length, groups, nodes, review,
    latest: Number.isFinite(latest) ? new Date(latest).toISOString() : null };
}

export function throttleText(value: unknown) {
  const report = healthRecord(value);
  if (report.available === false) return "Unavailable on controller";
  const flags = Array.isArray(report.flags) ? report.flags.filter(flag => typeof flag === "string") : [];
  return flags.join(", ") || healthString(report.raw) || healthString(value) || "Not reported";
}

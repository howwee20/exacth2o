/**
 * The experiment Record: one time lane joining plan revisions, calibration, controller settings,
 * reading gaps, valve openings and notes. Each item keeps two times apart — when it happened and
 * when the system recorded it — and says whether it was recorded or derived from readings. Pure.
 */
import { sensorBoard } from "./benchLayout";
import { potNumberFromPairingName, potRangeText } from "./experimentFactors";
import { controlCommandLabel } from "./portalFormat";
import type { PotNote } from "./potNotesClient";
import type { ControlCommandType } from "./portalTypes";
import type { PairingRow } from "./types";
import type { PotBucket } from "./workbenchModel";

const minute = 60_000;
const hour = 60 * minute;

export type RecordKind = "plan" | "calibration" | "settings" | "gap" | "watering" | "note";

export const recordKinds: { kind: RecordKind; label: string; mark: string }[] = [
  { kind: "plan", label: "Plan", mark: "◆" },
  { kind: "calibration", label: "Calibration", mark: "▲" },
  { kind: "settings", label: "Controller settings", mark: "■" },
  { kind: "gap", label: "Gaps in readings", mark: "▭" },
  { kind: "watering", label: "Valve openings", mark: "│" },
  { kind: "note", label: "Notes", mark: "●" },
];

export type RecordItem = {
  id: string;
  kind: RecordKind;
  /** When it happened (controller, sensor or observer time). */
  happenedAt: number;
  /** When the system recorded it, if that differs meaningfully; null for derived items. */
  recordedAt: number | null;
  endAt?: number | null;
  ongoing?: boolean;
  title: string;
  detail?: string;
  pots: string[];
  status?: "succeeded" | "failed" | "pending" | "rejected" | "approved" | "applied" | "requested" | null;
  actor?: string | null;
  /** Who did it, when known; your own actions are not "new" to you. */
  actorId?: string | null;
  /** Recorded rows count for "since you last looked"; derived items never do. */
  basis: "recorded" | "derived";
  source: string;
  calibration?: { name: string | null; pairingNames: string[]; atMs: number } | null;
  /** A count the lane draws (valve openings in a day). */
  value?: number;
};

// ---------------------------------------------------------------- plan

export type RevisionRow = { id: string; version: number; source: string | null; created_at: string; created_by: string | null };
export type AuditRow = { id: string; event_type: string; revision_id: string | null; details: Record<string, unknown> | null; created_at: string; actor_id: string | null };
export type AssignmentRow = {
  revision_id: string;
  pairing_name: string;
  pot_number: number;
  treatment: string | null;
  target_vwc_percent: number | null;
  calibration_name_snapshot: string | null;
};

const auditTitles: Record<string, string> = {
  legacy_imported: "Imported from the earlier experiment list",
  published_sensing: "Published for sensing",
  activation_requested: "Watering activation requested",
  activation_succeeded: "Watering activated on the controller",
  activation_failed: "Watering activation failed",
  completed: "Experiment completed",
  archived: "Experiment archived",
  restored: "Experiment restored",
};

function changes<T>(previous: readonly AssignmentRow[], next: readonly AssignmentRow[], pick: (row: AssignmentRow) => T) {
  const before = new Map(previous.map((row) => [row.pairing_name, pick(row)]));
  const moved = new Map<string, string[]>();
  for (const row of next) {
    if (!before.has(row.pairing_name)) continue;
    const from = before.get(row.pairing_name);
    const to = pick(row);
    if (from === to) continue;
    const key = `${from ?? "not set"} → ${to ?? "not set"}`;
    moved.set(key, [...(moved.get(key) ?? []), row.pairing_name]);
  }
  return moved;
}

export function planItems(revisions: readonly RevisionRow[], audits: readonly AuditRow[], assignments: readonly AssignmentRow[]): RecordItem[] {
  const byRevision = new Map<string, AssignmentRow[]>();
  for (const row of assignments) byRevision.set(row.revision_id, [...(byRevision.get(row.revision_id) ?? []), row]);
  const ordered = revisions.slice().sort((a, b) => a.version - b.version);
  const items: RecordItem[] = [];
  ordered.forEach((revision, index) => {
    const previous = index ? byRevision.get(ordered[index - 1].id) ?? [] : [];
    const current = byRevision.get(revision.id) ?? [];
    const summary = audits.find((audit) => audit.revision_id === revision.id && audit.event_type === "revision_created")?.details?.summary;
    const lines: string[] = [];
    if (index) {
      for (const [change, pots] of changes(previous, current, (row) => (row.target_vwc_percent == null ? null : `${row.target_vwc_percent}%`))) lines.push(`Planned target ${change} for ${potsText(pots)}`);
      for (const [change, pots] of changes(previous, current, (row) => row.treatment)) lines.push(`Treatment ${change} for ${potsText(pots)}`);
      for (const [change, pots] of changes(previous, current, (row) => row.calibration_name_snapshot)) lines.push(`Calibration in the plan ${change} for ${potsText(pots)}`);
    }
    items.push({
      id: `revision:${revision.id}`,
      kind: "plan",
      happenedAt: Date.parse(revision.created_at),
      recordedAt: null,
      title: index ? `Plan version ${revision.version}${typeof summary === "string" ? `: ${summary}` : ""}` : `Plan version ${revision.version} recorded`,
      detail: lines.length ? lines.join(". ") + "." : index ? "No pot-level change to targets, treatments or calibration." : `${current.length} pots in the plan.`,
      pots: index ? Array.from(new Set(lines.length ? current.filter((row) => previous.find((old) => old.pairing_name === row.pairing_name && (old.target_vwc_percent !== row.target_vwc_percent || old.treatment !== row.treatment || old.calibration_name_snapshot !== row.calibration_name_snapshot))).map((row) => row.pairing_name) : [])) : [],
      actorId: revision.created_by,
      basis: "recorded",
      source: "experiment_revisions",
      calibration: null,
    });
  });
  for (const audit of audits) {
    if (audit.event_type === "revision_created") continue;
    items.push({
      id: `audit:${audit.id}`,
      kind: "plan",
      happenedAt: Date.parse(audit.created_at),
      recordedAt: null,
      title: auditTitles[audit.event_type] ?? audit.event_type.replace(/_/g, " "),
      detail: typeof audit.details?.reason === "string" ? audit.details.reason : undefined,
      pots: [],
      status: audit.event_type === "activation_failed" ? "failed" : null,
      actorId: audit.actor_id,
      basis: "recorded",
      source: "experiment_audit_events",
    });
  }
  return items;
}

// ---------------------------------------------------------------- controller settings and calibration

export type CommandRow = {
  id: string;
  command_type: ControlCommandType;
  payload: Record<string, unknown> | null;
  status: string;
  requested_at: string;
  confirmed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  experiment_id: string | null;
  requested_by: string | null;
};

function payloadPots(payload: Record<string, unknown> | null) {
  if (!payload) return [];
  const names = new Set<string>();
  if (typeof payload.pairing_name === "string") names.add(payload.pairing_name);
  if (Array.isArray(payload.pairing_names)) for (const name of payload.pairing_names) if (typeof name === "string") names.add(name);
  if (Array.isArray(payload.pairings)) {
    for (const entry of payload.pairings) {
      if (entry && typeof entry === "object" && typeof (entry as { pairing_name?: unknown }).pairing_name === "string") names.add((entry as { pairing_name: string }).pairing_name);
    }
  }
  return Array.from(names);
}

function settingText(payload: Record<string, unknown> | null) {
  if (!payload) return null;
  const first = Array.isArray(payload.pairings) && payload.pairings[0] && typeof payload.pairings[0] === "object" ? (payload.pairings[0] as Record<string, unknown>) : payload;
  const parts: string[] = [];
  const target = first.target_vwc_percent ?? first.target_vwc ?? first.wtc_percent_limit;
  if (typeof target === "number") parts.push(`controller target ${target}%`);
  if (typeof first.valve_open_time_ms === "number") parts.push(`valve open time ${first.valve_open_time_ms / 1000} s`);
  if (typeof first.measurement_interval_seconds === "number") parts.push(`readings every ${first.measurement_interval_seconds / 60} min`);
  if (first.disable_watering === true) parts.push("automatic watering off");
  if (first.disable_watering === false) parts.push("automatic watering on");
  if (typeof payload.state === "string") parts.push(`state ${payload.state}`);
  if (typeof payload.board === "string") parts.push(`board ${payload.board}`);
  return parts.length ? parts.join(", ") : null;
}

const statusOf = (status: string): RecordItem["status"] =>
  status === "succeeded" ? "succeeded" : status === "failed" || status === "expired" || status === "canceled" ? "failed" : "pending";

/** Commands that touch the experiment's pots (or the whole controller). */
export function settingsItems(commands: readonly CommandRow[], experimentPots: readonly string[], experimentDatabaseId: string | null): RecordItem[] {
  const pots = new Set(experimentPots);
  const controllerWide = new Set<ControlCommandType>(["update_system_state", "update_board_config", "initialize_sensors"]);
  return commands.flatMap((command): RecordItem[] => {
    const touched = payloadPots(command.payload).filter((name) => pots.has(name));
    const relevant = touched.length || controllerWide.has(command.command_type) || (experimentDatabaseId && command.experiment_id === experimentDatabaseId);
    if (!relevant || command.command_type === "export_data") return [];
    const happened = Date.parse(command.completed_at ?? command.started_at ?? command.requested_at);
    const requested = Date.parse(command.requested_at);
    const isCalibration = command.command_type === "apply_calibration" || command.command_type === "create_calibration";
    const calibrationName = typeof command.payload?.calibration_name === "string" ? command.payload.calibration_name : null;
    const label = controlCommandLabel(command.command_type) ?? command.command_type;
    const what = isCalibration
      ? `Calibration ${calibrationName ?? ""} applied${touched.length ? ` to ${potsText(touched)}` : ""}`.replace(/\s+/g, " ")
      : command.command_type === "manual_water"
        ? `Manual watering requested for ${potsText(touched)}`
        : `${label}${touched.length ? ` for ${potsText(touched)}` : ""}`;
    const settings = settingText(command.payload);
    const status = statusOf(command.status);
    return [{
      id: `command:${command.id}`,
      kind: isCalibration ? "calibration" : "settings",
      happenedAt: happened,
      recordedAt: Math.abs(happened - requested) > minute ? requested : null,
      title: status === "failed" ? `${what} — did not complete` : status === "pending" ? `${what} — not yet confirmed by the controller` : what,
      detail: [settings, command.error ? `Controller reported: ${command.error}` : null, command.command_type === "manual_water" ? "A controller command, not measured water." : null].filter(Boolean).join(". ") || undefined,
      pots: touched,
      status,
      actorId: command.requested_by,
      basis: "recorded",
      source: "project_control_commands",
      calibration: isCalibration && status === "succeeded" ? { name: calibrationName, pairingNames: touched, atMs: happened } : null,
    }];
  });
}

export type CalibrationRequestRow = {
  id: string;
  pairing_names: string[];
  status: string;
  requested_at: string;
  reviewed_at: string | null;
  notes: string | null;
  candidate: { version: number; fit_type: string; equation_text: string | null; rmse: number | null; sample_count: number | null } | null;
  study_name: string | null;
};

export function calibrationRequestItems(rows: readonly CalibrationRequestRow[], experimentPots: readonly string[]): RecordItem[] {
  const pots = new Set(experimentPots);
  return rows.flatMap((row): RecordItem[] => {
    const touched = row.pairing_names.filter((name) => pots.has(name));
    if (!touched.length) return [];
    const fit = row.candidate
      ? `${row.study_name ? `${row.study_name}, ` : ""}fit v${row.candidate.version} (${row.candidate.fit_type}${row.candidate.rmse != null ? `, RMSE ${row.candidate.rmse.toFixed(2)}` : ""}${row.candidate.sample_count != null ? `, ${row.candidate.sample_count} samples` : ""})`
      : row.study_name ?? "calibration fit";
    const happened = Date.parse(row.reviewed_at ?? row.requested_at);
    const statusText: Record<string, string> = {
      approval_requested: "approval requested",
      approved: "approved",
      applied: "applied",
      rejected: "rejected",
      failed: "failed",
    };
    return [{
      id: `calibration-request:${row.id}`,
      kind: "calibration",
      happenedAt: happened,
      recordedAt: row.reviewed_at ? Date.parse(row.requested_at) : null,
      title: `Calibration ${fit} ${statusText[row.status] ?? row.status} for ${potsText(touched)}`,
      detail: [row.candidate?.equation_text ? `Equation: ${row.candidate.equation_text}` : null, row.notes].filter(Boolean).join(". ") || undefined,
      pots: touched,
      status: row.status === "applied" ? "applied" : row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : row.status === "failed" ? "failed" : "requested",
      basis: "recorded",
      source: "calibration_set_requests",
      calibration: null,
    }];
  });
}

// ---------------------------------------------------------------- notes

export function noteItems(notes: readonly PotNote[]): RecordItem[] {
  return notes.map((note) => ({
    id: `note:${note.id}`,
    kind: "note",
    happenedAt: Date.parse(note.observed_at),
    recordedAt: Math.abs(Date.parse(note.recorded_at) - Date.parse(note.observed_at)) > 2 * minute || note.client_context?.written_offline === true ? Date.parse(note.recorded_at) : null,
    title: `${note.supersedes_id ? "Correction — " : ""}${note.body}`,
    detail: note.tags.length ? note.tags.join(" · ") : undefined,
    pots: [note.pairing_name],
    actor: note.author_label,
    actorId: note.created_by,
    basis: "recorded",
    source: "portal_pot_notes",
  }));
}

// ---------------------------------------------------------------- gaps (derived)

export type GapRow = { pairingName: string; startMs: number; endMs: number; ongoing: boolean };

/**
 * Stretches with no readings (found by public.portal_reading_gaps from hourly buckets). Pots that
 * went silent together on the same sensor board are reported as one gap.
 */
export function gapItems(gaps: readonly GapRow[], pairings: readonly PairingRow[]): RecordItem[] {
  const boardOf = new Map(pairings.map((pairing) => [pairing.name, sensorBoard(pairing.sensor_key)]));
  const runs = new Map<string, { startMs: number; endMs: number; ongoing: boolean; pots: string[]; board: string | null }>();
  for (const gap of gaps) {
    const board = boardOf.get(gap.pairingName) ?? null;
    const key = `${gap.startMs}:${gap.endMs}:${gap.ongoing}:${board ?? "?"}`;
    const run = runs.get(key) ?? { startMs: gap.startMs, endMs: gap.endMs, ongoing: gap.ongoing, pots: [], board };
    run.pots.push(gap.pairingName);
    runs.set(key, run);
  }
  return Array.from(runs.values()).map((run) => {
    const hours = Math.max(1, Math.round((run.endMs - run.startMs) / hour));
    return {
      id: `gap:${run.startMs}:${run.board}:${run.pots[0]}`,
      kind: "gap" as const,
      happenedAt: run.startMs,
      recordedAt: null,
      endAt: run.ongoing ? null : run.endMs,
      ongoing: run.ongoing,
      title: `No readings from ${potsText(run.pots)}${run.board ? ` (sensor board ${run.board})` : ""} ${run.ongoing ? `since then (${hours} h so far)` : `for about ${hours} h`}`,
      detail: "Derived from the readings: hourly stretches with no reading. Nothing was filled in.",
      pots: run.pots,
      basis: "derived" as const,
      source: "sensor_readings",
    };
  });
}

// ---------------------------------------------------------------- valve openings (derived density)

export type DailyOpenings = { dayStartMs: number; openings: number; pots: number; commandedOpenMs: number };

export function wateringItems(days: readonly DailyOpenings[]): RecordItem[] {
  return days.filter((entry) => entry.openings > 0).map((entry) => ({
    id: `watering:${entry.dayStartMs}`,
    kind: "watering" as const,
    happenedAt: entry.dayStartMs,
    recordedAt: null,
    endAt: entry.dayStartMs + 24 * hour,
    title: `${entry.openings} valve ${entry.openings === 1 ? "opening" : "openings"} across ${entry.pots} ${entry.pots === 1 ? "pot" : "pots"}`,
    value: entry.openings,
    detail: `Valves were told to open for ${Math.round(entry.commandedOpenMs / 1000)} s in total — controller events, not measured water.`,
    pots: [],
    basis: "derived" as const,
    source: "valve_events",
  }));
}

// ---------------------------------------------------------------- lane

export function sortRecord(items: readonly RecordItem[]) {
  return items.slice().sort((a, b) => b.happenedAt - a.happenedAt || a.id.localeCompare(b.id));
}

/** Recorded items that arrived after the reader last looked (by record time, else happened time), other than the reader's own. */
export function newSince(items: readonly RecordItem[], lastSeenMs: number | null, readerId: string | null = null) {
  if (lastSeenMs == null) return new Set<string>();
  return new Set(items
    .filter((item) => item.basis === "recorded" && (item.recordedAt ?? item.happenedAt) > lastSeenMs && (!readerId || item.actorId !== readerId))
    .map((item) => item.id));
}

export function filterRecord(items: readonly RecordItem[], kinds: ReadonlySet<RecordKind>, pot: string | null) {
  return items.filter((item) => kinds.has(item.kind) && (!pot || !item.pots.length || item.pots.includes(pot)));
}

// ---------------------------------------------------------------- calibration explanation

export type CalibrationStep = {
  calibratedBefore: number;
  calibratedAfter: number;
  rawBefore: number;
  rawAfter: number;
  /** Calibrated value per unit of raw output, before and after. */
  ratioBefore: number;
  ratioAfter: number;
  rawChangePercent: number;
  ratioChangePercent: number;
  conclusion: "calibration" | "physical-too" | "unclear";
};

/**
 * Descriptive evidence around a calibration moment. This ratio heuristic is not a causal
 * test or a replacement for the recorded calibration equation; use paired finite buckets.
 */
export function calibrationStep(buckets: readonly PotBucket[], atMs: number, sideMs = 40 * minute): CalibrationStep | null {
  const paired = buckets.filter((bucket) => bucket.readings > 0 && Number.isFinite(bucket.values.vwc) && Number.isFinite(bucket.values.raw));
  const before = paired.filter((bucket) => bucket.startMs + 10 * minute <= atMs && bucket.startMs >= atMs - sideMs);
  const after = paired.filter((bucket) => bucket.startMs >= atMs && bucket.startMs < atMs + sideMs);
  if (before.length < 2 || after.length < 2) return null;
  const mean = (rows: readonly PotBucket[], key: "vwc" | "raw") => {
    const values = rows.map((row) => row.values[key]).filter((value): value is number => value != null && Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const calibratedBefore = mean(before, "vwc");
  const calibratedAfter = mean(after, "vwc");
  const rawBefore = mean(before, "raw");
  const rawAfter = mean(after, "raw");
  if (calibratedBefore == null || calibratedAfter == null || rawBefore == null || rawAfter == null || rawBefore === 0 || rawAfter === 0) return null;
  const ratioBefore = calibratedBefore / rawBefore;
  const ratioAfter = calibratedAfter / rawAfter;
  if (!Number.isFinite(ratioBefore) || !Number.isFinite(ratioAfter) || ratioBefore === 0) return null;
  const rawChangePercent = ((rawAfter - rawBefore) / Math.abs(rawBefore)) * 100;
  const ratioChangePercent = ((ratioAfter - ratioBefore) / Math.abs(ratioBefore)) * 100;
  const conversionMoved = Math.abs(ratioChangePercent) >= 1;
  const rawMoved = Math.abs(rawChangePercent) >= 2;
  return {
    calibratedBefore,
    calibratedAfter,
    rawBefore,
    rawAfter,
    ratioBefore,
    ratioAfter,
    rawChangePercent,
    ratioChangePercent,
    conclusion: conversionMoved && !rawMoved ? "calibration" : conversionMoved && rawMoved ? "physical-too" : "unclear",
  };
}

export function potsText(pairingNames: readonly string[]) {
  const numbers = pairingNames.map((name) => potNumberFromPairingName(name)).filter((value): value is number => value != null);
  return numbers.length ? potRangeText(numbers) : pairingNames.join(", ");
}


/** Draw adjacent valid buckets only; missing measurements stay visible as gaps. */
export function calibrationSegments(buckets: readonly PotBucket[], key: "vwc" | "raw", bucketMs = 10 * minute) {
  const segments: { timestampMs: number; value: number }[][] = [];
  let previousMs: number | null = null;
  let current: { timestampMs: number; value: number }[] | null = null;
  for (const bucket of [...buckets].sort((a, b) => a.startMs - b.startMs)) {
    const value = bucket.values[key];
    if (!bucket.readings || value == null || !Number.isFinite(value)) {
      current = null;
      previousMs = null;
      continue;
    }
    if (!current || previousMs == null || bucket.startMs - previousMs > bucketMs) {
      current = [];
      segments.push(current);
    }
    current.push({ timestampMs: bucket.startMs + bucketMs / 2, value });
    previousMs = bucket.startMs;
  }
  return segments;
}

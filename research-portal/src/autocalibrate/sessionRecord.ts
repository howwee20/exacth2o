import type { HeldBack, PotSettingsSnapshot, ValveChange } from "../commissioning/topologyPlan";
import type {
  CommissioningConfig,
  CommissioningMode,
  CommissioningResult,
  LogEntry,
  RunOutcome,
  SelectedPot,
} from "../commissioning/types";
import type { CommissioningSessionRow } from "../commissioningRecords";

// The durable record of one autocalibration session (public.commissioning_sessions)
// and the decisions made from the record alone. Decisions that compare it with the
// controller's configuration are in sessionReview.ts. The server keeps each pot's original settings
// in original_snapshot (immutable); `record` holds everything that happened since.

export const recordSchema = 2;

export type BatchKind = "prepare" | "apply" | "rollback" | "restore";

/**
 * One reviewed settings batch this session queued. Two separate facts are tracked:
 * what the command queue reports, and what the controller's own configuration shows
 * when it is read back. Only the readback says the change is in force.
 */
export type TrackedBatch = {
  kind: BatchKind;
  batchId: string | null;
  commandIds: string[];
  queuedAt: string;
  summary: string;
  commands: "queued" | "succeeded" | "failed" | "unknown";
  error: string | null;
  readback: "pending" | "verified" | "not_applied" | "mismatch";
  verifiedAt: string | null;
  changes?: ValveChange[];
  pairingNames?: string[];
  reconciled?: { count: number; skipped: Array<{ pairing_name: string; reason: string }> } | null;
};

export type SessionEvent = { at: string; who: string | null; message: string };

/** Small progress note saved with each checkpoint, so other screens can follow a run. */
export type RunProgressNote = {
  updatedAt: string;
  segment: number;
  phase: string;
  completed: number;
  total: number;
  pulsesRequested: number;
  valveSecondsRequested: number;
  activeValveKey: string | null;
  outcome: RunOutcome | null;
  stopReason: string | null;
};

/** A rehearsal is kept only as a summary: it opened no valve and is never resumed. */
export type RehearsalSummary = {
  at: string;
  outcome: RunOutcome;
  stopReason: string | null;
  usableBaselines: number;
  total: number;
  log: LogEntry[];
};

export type SessionRecord = {
  schema: number;
  experimentId: string;
  experimentName: string;
  selection: SelectedPot[];
  mode: CommissioningMode | null;
  config: CommissioningConfig | null;
  /** The latest run segment's progress. The evidence itself is in run_result. */
  progress: RunProgressNote | null;
  rehearsal: RehearsalSummary | null;
  approvedCycles: string[];
  batches: TrackedBatch[];
  heldBack: HeldBack[];
  carriedForward: Array<{ pairingName: string; fromRunId: string }>;
  events: SessionEvent[];
};

export type SessionStatus =
  | "preparing" | "prepared" | "running" | "interrupted" | "analyzed" | "applying" | "applied"
  | "verified" | "restoring" | "restored" | "rolled_back" | "abandoned" | "failed";

export function emptyRecord(input: { experimentId: string; experimentName: string; selection: SelectedPot[]; carriedForward?: SessionRecord["carriedForward"] }): SessionRecord {
  return {
    schema: recordSchema,
    experimentId: input.experimentId,
    experimentName: input.experimentName,
    selection: input.selection,
    mode: null,
    config: null,
    progress: null,
    rehearsal: null,
    approvedCycles: [],
    batches: [],
    heldBack: [],
    carriedForward: input.carriedForward ?? [],
    events: [],
  };
}

export function parseRecord(row: Pick<CommissioningSessionRow, "record">): SessionRecord {
  const raw = (row.record ?? {}) as Partial<SessionRecord>;
  return {
    schema: Number(raw.schema) || recordSchema,
    experimentId: String(raw.experimentId ?? "installation"),
    experimentName: String(raw.experimentName ?? "Installation"),
    selection: Array.isArray(raw.selection) ? raw.selection : [],
    mode: raw.mode ?? null,
    config: raw.config ?? null,
    progress: raw.progress ?? null,
    rehearsal: raw.rehearsal ?? null,
    approvedCycles: Array.isArray(raw.approvedCycles) ? raw.approvedCycles : [],
    batches: Array.isArray(raw.batches) ? raw.batches : [],
    heldBack: Array.isArray(raw.heldBack) ? raw.heldBack : [],
    carriedForward: Array.isArray(raw.carriedForward) ? raw.carriedForward : [],
    events: Array.isArray(raw.events) ? raw.events : [],
  };
}

export function parseSnapshot(row: Pick<CommissioningSessionRow, "original_snapshot">): PotSettingsSnapshot[] {
  return Array.isArray(row.original_snapshot) ? row.original_snapshot as PotSettingsSnapshot[] : [];
}

export function withEvent(record: SessionRecord, who: string | null, message: string, atMs = Date.now()): SessionRecord {
  return { ...record, events: [...record.events, { at: new Date(atMs).toISOString(), who, message }].slice(-400) };
}

export function latestBatch(record: SessionRecord, kind: BatchKind) {
  for (let index = record.batches.length - 1; index >= 0; index -= 1) if (record.batches[index].kind === kind) return record.batches[index];
  return null;
}

export function replaceBatch(record: SessionRecord, batch: TrackedBatch): SessionRecord {
  const index = record.batches.findIndex((item) => item.batchId === batch.batchId && item.kind === batch.kind && item.queuedAt === batch.queuedAt);
  const batches = record.batches.slice();
  if (index >= 0) batches[index] = batch; else batches.push(batch);
  return { ...record, batches };
}

// ------------------------------------------------------------------ run ownership

/** A heartbeat older than this means the screen running the session is gone. */
export const heartbeatStaleMs = 3 * 60_000;

export function heartbeatFresh(row: Pick<CommissioningSessionRow, "heartbeat_at">, nowMs: number) {
  const at = row.heartbeat_at ? Date.parse(row.heartbeat_at) : NaN;
  return Number.isFinite(at) && nowMs - at < heartbeatStaleMs;
}

export type WorkspaceStage = "select" | "prepare" | "check" | "run" | "review" | "restore" | "closed";

/**
 * Where the workspace stands for a session. A run belongs to one screen: when its
 * heartbeat stops (the screen closed or lost its connection), no further pulse is
 * requested and the session reads as interrupted, ready to resume from its evidence.
 */
export function sessionStage(row: CommissioningSessionRow | null, options: { runningHere: boolean; nowMs: number }): { stage: WorkspaceStage; remoteRun: boolean; staleRun: boolean } {
  if (!row) return { stage: "select", remoteRun: false, staleRun: false };
  if (!row.active) return { stage: "closed", remoteRun: false, staleRun: false };
  switch (row.status as SessionStatus) {
    case "preparing":
      return { stage: "prepare", remoteRun: false, staleRun: false };
    case "prepared":
    case "interrupted":
    case "failed":
      return { stage: "check", remoteRun: false, staleRun: false };
    case "running":
      if (options.runningHere) return { stage: "run", remoteRun: false, staleRun: false };
      return heartbeatFresh(row, options.nowMs)
        ? { stage: "run", remoteRun: true, staleRun: false }
        : { stage: "check", remoteRun: false, staleRun: true };
    case "analyzed":
    case "applying":
    case "applied":
    case "verified":
    case "rolled_back":
      return { stage: "review", remoteRun: false, staleRun: false };
    case "restoring":
      return { stage: "restore", remoteRun: false, staleRun: false };
    default:
      return { stage: "closed", remoteRun: false, staleRun: false };
  }
}

export function progressNote(input: {
  segment: number; phase: string; completed: number; total: number; pulsesRequested: number; valveSecondsRequested: number;
  activeValveKey: string | null; outcome?: RunOutcome | null; stopReason?: string | null; atMs?: number;
}): RunProgressNote {
  return {
    updatedAt: new Date(input.atMs ?? Date.now()).toISOString(),
    segment: input.segment,
    phase: input.phase,
    completed: input.completed,
    total: input.total,
    pulsesRequested: input.pulsesRequested,
    valveSecondsRequested: input.valveSecondsRequested,
    activeValveKey: input.activeValveKey,
    outcome: input.outcome ?? null,
    stopReason: input.stopReason ?? null,
  };
}

export function rehearsalSummary(result: CommissioningResult): RehearsalSummary {
  return {
    at: result.endedAt,
    outcome: result.outcome,
    stopReason: result.stopReason,
    usableBaselines: result.baselines.filter((item) => item.valid).length,
    total: result.pots.length,
    log: result.log.slice(-40),
  };
}

/**
 * The session status a finished run segment leaves behind. A rehearsal changes nothing:
 * a session with an interrupted real run stays resumable after it.
 */
export function statusAfterRun(outcome: RunOutcome, mode: CommissioningMode, before: SessionStatus | string = "prepared"): SessionStatus {
  if (mode === "dry_run") return before === "interrupted" || before === "failed" ? "interrupted" : "prepared";
  return outcome === "completed" || outcome === "completed_with_findings" ? "analyzed" : "interrupted";
}

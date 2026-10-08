import { loadPotNotes, type PotNote } from "./potNotesClient";
import type { AssignmentRow, AuditRow, CalibrationRequestRow, CommandRow, DailyOpenings, GapRow, RevisionRow } from "./recordModel";
import { supabase } from "./supabase";
import { emptyStats, loadReadingBuckets, loadValveOpenBuckets, type FetchStats } from "./workbenchClient";

const hour = 3_600_000;
const day = 24 * hour;

export type RecordSources = {
  revisions: RevisionRow[];
  audits: AuditRow[];
  assignments: AssignmentRow[];
  commands: CommandRow[];
  calibrationRequests: CalibrationRequestRow[];
  notes: PotNote[];
  gaps: GapRow[];
  daily: DailyOpenings[];
  lastSeenAt: string | null;
  problems: string[];
  stats: FetchStats;
};

/** Page bounded histories; never silently present a server row limit as a complete record. */
export async function readRecordPages<T>(fetchPage: (from: number, to: number) => Promise<T[]>, cap = 10000): Promise<T[]> {
  const rows: T[] = [];
  while (rows.length < cap) {
    const size = Math.min(1000, cap - rows.length);
    const page = await fetchPage(rows.length, rows.length + size - 1);
    rows.push(...page);
    if (page.length < size) return rows;
  }
  if ((await fetchPage(cap, cap)).length) throw new Error(`history exceeds the ${cap}-row review limit`);
  return rows;
}

function localMidnight(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Everything the Record shows for one experiment over a window, read with the signed-in account's
 * own permissions. A source that fails is named in `problems`; the rest still load.
 */
export async function loadRecordSources(input: {
  projectId: string;
  deviceId: string;
  experimentDatabaseId: string;
  pairingNames: readonly string[];
  startMs: number;
  endMs: number;
}): Promise<RecordSources> {
  const stats = emptyStats();
  const problems: string[] = [];
  const startIso = new Date(input.startMs).toISOString();
  const endIso = new Date(input.endMs).toISOString();
  const count = <T,>(rows: T[] | null) => {
    stats.requests += 1;
    stats.rows += rows?.length ?? 0;
    stats.bytes += rows ? JSON.stringify(rows).length : 0;
    return rows ?? [];
  };
  const settle = async <T,>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      stats.failed += 1;
      problems.push(`${label} could not be loaded (${error instanceof Error ? error.message : "error"}).`);
      return fallback;
    }
  };

  const pages = <T,>(query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>, cap = 10000) =>
    readRecordPages<T>(async (from, to) => {
      const { data, error } = await query(from, to);
      if (error) throw error;
      return count(data) as T[];
    }, cap);
  const gapStart = Math.max(input.endMs - 120 * day, Math.floor(input.startMs / hour) * hour);
  const dailyOrigin = localMidnight(input.startMs);

  const [revisions, audits, assignments, commands, requests, notes, gaps, valves, mark] = await Promise.all([
    settle("Plan versions", async () => {
      return pages<RevisionRow>((from, to) => supabase.from("experiment_revisions").select("id,version,source,created_at,created_by")
        .eq("experiment_id", input.experimentDatabaseId).order("version", { ascending: true }).range(from, to), 2000);
    }, [] as RevisionRow[]),
    settle("Experiment events", async () => {
      return pages<AuditRow>((from, to) => supabase.from("experiment_audit_events").select("id,event_type,revision_id,details,created_at,actor_id")
        .eq("experiment_id", input.experimentDatabaseId).order("created_at", { ascending: true }).order("id").range(from, to));
    }, [] as AuditRow[]),
    settle("Plan assignments", async () => {
      return pages<AssignmentRow>((from, to) => supabase.from("experiment_assignments").select("revision_id,pairing_name,pot_number,treatment,target_vwc_percent,calibration_name_snapshot")
        .eq("experiment_id", input.experimentDatabaseId).order("revision_id").order("pairing_name").range(from, to), 20000);
    }, [] as AssignmentRow[]),
    settle("Controller settings", async () => {
      return pages<CommandRow>((from, to) => supabase.from("project_control_commands")
        .select("id,command_type,payload,status,requested_at,confirmed_at,started_at,completed_at,error,experiment_id,requested_by")
        .eq("project_id", input.projectId).eq("device_id", input.deviceId)
        .gte("requested_at", startIso).lte("requested_at", endIso)
        .order("requested_at", { ascending: false }).order("id").range(from, to), 5000);
    }, [] as CommandRow[]),
    settle("Calibration requests", async () => {
      const rows = await pages<Omit<CalibrationRequestRow, "candidate" | "study_name"> & { candidate_id: string; study_id: string }>((from, to) => supabase.from("calibration_set_requests")
        .select("id,pairing_names,status,requested_at,reviewed_at,notes,candidate_id,study_id")
        .eq("project_id", input.projectId).gte("requested_at", startIso).lte("requested_at", endIso)
        .order("requested_at", { ascending: false }).order("id").range(from, to), 1000);
      if (!rows.length) return [] as CalibrationRequestRow[];
      const [candidates, studies] = await Promise.all([
        supabase.from("calibration_candidates").select("id,version,fit_type,equation_text,rmse,sample_count").in("id", rows.map((row) => row.candidate_id)),
        supabase.from("calibration_studies").select("id,name").in("id", rows.map((row) => row.study_id)),
      ]);
      if (candidates.error) throw candidates.error;
      if (studies.error) throw studies.error;
      count(candidates.data);
      count(studies.data);
      const candidateById = new Map((candidates.data ?? []).map((row) => [row.id as string, row]));
      const studyById = new Map((studies.data ?? []).map((row) => [row.id as string, row.name as string]));
      return rows.map((row) => ({
        ...row,
        candidate: (candidateById.get(row.candidate_id) as CalibrationRequestRow["candidate"]) ?? null,
        study_name: studyById.get(row.study_id) ?? null,
      }));
    }, [] as CalibrationRequestRow[]),
    settle("Notes", async () => {
      const rows = await loadPotNotes(input.projectId, input.deviceId, { pairingNames: input.pairingNames, sinceIso: startIso, untilIso: endIso, limit: 1000 });
      if (rows.length >= 1000) {
        stats.failed += 1;
        problems.push("Notes reached the 1000-note review limit; this record may be incomplete.");
      }
      return count(rows);
    }, [] as PotNote[]),
    settle("Gaps in readings", async () => {
      const rows = await pages<{ pairing_name: string; gap_start: string; gap_end: string; ongoing: boolean }>((from, to) => supabase.rpc("portal_reading_gaps", {
        p_project_id: input.projectId,
        p_device_id: input.deviceId,
        p_pairing_names: [...input.pairingNames],
        p_start: new Date(gapStart).toISOString(),
        p_end: endIso,
        p_bucket_seconds: 3600,
        p_min_buckets: 2,
      }).order("pairing_name").order("gap_start").range(from, to));
      return rows.map((row): GapRow => ({
        pairingName: row.pairing_name,
        startMs: Date.parse(row.gap_start),
        endMs: Date.parse(row.gap_end),
        ongoing: row.ongoing,
      }));
    }, [] as GapRow[]),
    settle("Valve openings", () => loadValveOpenBuckets({
      projectId: input.projectId, deviceId: input.deviceId, pairingNames: input.pairingNames,
      window: { queryStartMs: dailyOrigin, endMs: input.endMs, bucketMs: day },
    }, stats), []),
    settle("Your last visit", async () => {
      const { data, error } = await supabase.from("portal_experiment_views").select("last_seen_at").eq("experiment_id", input.experimentDatabaseId).maybeSingle();
      if (error) throw error;
      stats.requests += 1;
      return (data?.last_seen_at as string | undefined) ?? null;
    }, null as string | null),
  ]);

  const byDay = new Map<number, { openings: number; pots: Set<string>; ms: number }>();
  for (const bucket of valves) {
    const entry = byDay.get(bucket.startMs) ?? { openings: 0, pots: new Set<string>(), ms: 0 };
    entry.openings += bucket.openings;
    entry.ms += bucket.commandedOpenMs;
    if (bucket.openings) entry.pots.add(bucket.pairingName);
    byDay.set(bucket.startMs, entry);
  }
  const daily = Array.from(byDay.entries()).map(([dayStartMs, entry]) => ({ dayStartMs, openings: entry.openings, pots: entry.pots.size, commandedOpenMs: entry.ms }));

  return { revisions, audits, assignments, commands, calibrationRequests: requests, notes, gaps, daily, lastSeenAt: mark, problems, stats };
}

/**
 * Raw and calibrated buckets for one pot around a moment, with the valve openings the controller
 * recorded for it (for explaining a calibration step).
 */
export async function loadAround(input: { projectId: string; deviceId: string; pairingName: string; atMs: number; spanMs?: number }) {
  const span = input.spanMs ?? 6 * hour;
  const bucketMs = 10 * 60_000;
  const window = { queryStartMs: input.atMs - span, endMs: Math.min(Date.now(), input.atMs + span), bucketMs };
  const stats = emptyStats();
  const [buckets, valves] = await Promise.all([
    loadReadingBuckets({ projectId: input.projectId, deviceId: input.deviceId, pairingNames: [input.pairingName], window, exclusions: [] }, stats),
    loadValveOpenBuckets({ projectId: input.projectId, deviceId: input.deviceId, pairingNames: [input.pairingName], window }, stats),
  ]);
  if (stats.failed) throw new Error("The calibration window is incomplete. Retry before comparing the change.");
  return { buckets, openings: valves.filter((bucket) => bucket.openings > 0).map((bucket) => bucket.startMs + bucketMs / 2) };
}

/** Move this account's "last looked" mark forward (never back; the database keeps the later one). */
export async function markExperimentSeen(projectId: string, experimentDatabaseId: string, atIso: string) {
  const updated = await supabase.from("portal_experiment_views").update({ last_seen_at: atIso }).eq("experiment_id", experimentDatabaseId).select("experiment_id");
  if (updated.error) throw updated.error;
  if (updated.data?.length) return;
  const inserted = await supabase.from("portal_experiment_views").insert({ project_id: projectId, experiment_id: experimentDatabaseId, last_seen_at: atIso });
  // Another tab may have inserted first; its mark is as good as ours.
  if (inserted.error && inserted.error.code !== "23505") throw inserted.error;
}

export type AlignmentEvent = { key: string; label: string; atIso: string; kind: "start" | "plan" | "calibration"; pairingNames?: string[] };

/**
 * Recorded moments a comparison can be aligned to: the experiment start, each later plan version
 * (a treatment change) and each calibration the controller confirmed for the experiment's pots.
 */
export async function loadAlignmentEvents(input: {
  projectId: string;
  deviceId: string;
  experimentDatabaseId: string | null;
  startedAt: string | null;
  pairingNames: readonly string[];
}): Promise<AlignmentEvent[]> {
  const events: AlignmentEvent[] = [];
  if (input.startedAt) events.push({ key: "start", label: "Experiment started", atIso: input.startedAt, kind: "start" });
  if (input.experimentDatabaseId) {
    const [revisions, audits] = await Promise.all([
      supabase.from("experiment_revisions").select("id,version,created_at").eq("experiment_id", input.experimentDatabaseId).order("version").limit(200),
      supabase.from("experiment_audit_events").select("revision_id,details").eq("experiment_id", input.experimentDatabaseId).eq("event_type", "revision_created").limit(200),
    ]);
    if (revisions.error) throw revisions.error;
    if (audits.error) throw audits.error;
    if (revisions.data?.length === 200 || audits.data?.length === 200) throw new Error("Plan alignment history reached its review limit");
    const summaries = new Map((audits.data ?? []).map((row) => [row.revision_id as string, (row.details as { summary?: unknown } | null)?.summary]));
    for (const revision of (revisions.data ?? []) as { id: string; version: number; created_at: string }[]) {
      if (revision.version <= 1) continue;
      const summary = summaries.get(revision.id);
      events.push({ key: `revision:${revision.id}`, label: `Plan version ${revision.version}${typeof summary === "string" ? `: ${summary}` : ""}`, atIso: revision.created_at, kind: "plan" });
    }
  }
  const commands = await supabase.from("project_control_commands").select("id,payload,completed_at")
    .eq("project_id", input.projectId).eq("device_id", input.deviceId).eq("command_type", "apply_calibration").eq("status", "succeeded")
    .order("completed_at", { ascending: false }).limit(50);
  if (commands.error) throw commands.error;
  if (commands.data?.length === 50) throw new Error("Calibration alignment history reached its review limit");
  {
    const pots = new Set(input.pairingNames);
    for (const command of (commands.data ?? []) as { id: string; payload: Record<string, unknown> | null; completed_at: string | null }[]) {
      const names = Array.isArray(command.payload?.pairing_names) ? (command.payload?.pairing_names as unknown[]).filter((name): name is string => typeof name === "string") : [];
      if (!command.completed_at || !names.some((name) => pots.has(name))) continue;
      const calibration = typeof command.payload?.calibration_name === "string" ? command.payload.calibration_name : "a calibration";
      events.push({ key: `command:${command.id}`, label: `Calibration ${calibration} applied`, atIso: command.completed_at, kind: "calibration", pairingNames: names.filter((name) => pots.has(name)) });
    }
  }
  return events.sort((a, b) => a.atIso.localeCompare(b.atIso));
}

import { supabase } from "./supabase";
import { bucketRequestPlan, type ComparisonDefinition, type Exclusion, type PotBucket, type ResolvedWindow } from "./workbenchModel";

export type ComparisonRow = {
  id: string;
  project_id: string;
  device_id: string;
  experiment_id: string | null;
  question: string;
  definition: ComparisonDefinition;
  sharing: "private" | "project";
  created_by: string;
  author_label: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

const comparisonColumns = "id,project_id,device_id,experiment_id,question,definition,sharing,created_by,author_label,created_at,updated_at,archived_at";

/** Comparisons this account can read on the project (its own and shared ones), newest first. */
export async function listComparisons(projectId: string) {
  const { data, error } = await supabase
    .from("portal_comparisons")
    .select(comparisonColumns)
    .eq("project_id", projectId)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as ComparisonRow[];
}

export async function loadComparison(id: string) {
  const { data, error } = await supabase.from("portal_comparisons").select(comparisonColumns).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data ?? null) as ComparisonRow | null;
}

export async function createComparison(input: {
  projectId: string;
  deviceId: string;
  experimentDatabaseId: string | null;
  question: string;
  definition: ComparisonDefinition;
  sharing: "private" | "project";
  authorLabel: string;
}) {
  const { data, error } = await supabase
    .from("portal_comparisons")
    .insert({
      project_id: input.projectId,
      device_id: input.deviceId,
      experiment_id: input.experimentDatabaseId,
      question: input.question,
      definition: input.definition,
      sharing: input.sharing,
      author_label: input.authorLabel,
    })
    .select(comparisonColumns)
    .single();
  if (error) throw error;
  return data as ComparisonRow;
}

export async function updateComparison(id: string, patch: Partial<Pick<ComparisonRow, "question" | "definition" | "sharing" | "archived_at">>) {
  const { data, error } = await supabase.from("portal_comparisons").update(patch).eq("id", id).select(comparisonColumns).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Only the person who saved this comparison can change it.");
  return data as ComparisonRow;
}

type ExclusionRow = {
  id: string;
  pairing_name: string | null;
  starts_at: string | null;
  ends_at: string | null;
  reason: string;
  author_label: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by_label: string | null;
  revoke_reason: string | null;
};

const exclusionColumns = "id,pairing_name,starts_at,ends_at,reason,author_label,created_at,revoked_at,revoked_by_label,revoke_reason";

function toExclusion(row: ExclusionRow): Exclusion {
  return {
    id: row.id,
    pairingName: row.pairing_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reason: row.reason,
    authorLabel: row.author_label,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedByLabel: row.revoked_by_label,
    revokeReason: row.revoke_reason,
  };
}

export async function loadExclusions(comparisonId: string) {
  const pageSize = 500;
  const maxHistory = 10_000;
  const rows: ExclusionRow[] = [];
  for (let offset = 0; offset <= maxHistory; offset += pageSize) {
    const { data, error } = await supabase
      .from("portal_comparison_exclusions")
      .select(exclusionColumns)
      .eq("comparison_id", comparisonId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset === maxHistory ? offset : offset + pageSize - 1);
    if (error) throw new Error(`Exclusion history could not be fully loaded: ${error.message}`);
    const page = (data ?? []) as ExclusionRow[];
    if (offset === maxHistory && page.length) {
      throw new Error(`Exclusion history exceeds ${maxHistory.toLocaleString()} rows. This comparison cannot be analyzed or exported with an incomplete exclusion history.`);
    }
    rows.push(...page);
    if (page.length < pageSize) return rows.map(toExclusion);
  }
  return rows.map(toExclusion);
}

export async function addExclusion(input: {
  comparisonId: string;
  projectId: string;
  pairingName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  reason: string;
  authorLabel: string;
}) {
  const { data, error } = await supabase
    .from("portal_comparison_exclusions")
    .insert({
      comparison_id: input.comparisonId,
      project_id: input.projectId,
      pairing_name: input.pairingName,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      reason: input.reason,
      author_label: input.authorLabel,
    })
    .select(exclusionColumns)
    .single();
  if (error) throw error;
  return toExclusion(data as ExclusionRow);
}

export async function revokeExclusion(id: string, reason: string) {
  const { data, error } = await supabase
    .from("portal_comparison_exclusions")
    .update({ revoke_reason: reason })
    .eq("id", id)
    .select(exclusionColumns)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Only the person who saved this comparison can revoke its exclusions.");
  return toExclusion(data as ExclusionRow);
}

// ---------------------------------------------------------------- aggregates

export type FetchStats = { requests: number; rows: number; bytes: number; failed: number; ms: number };
export const emptyStats = (): FetchStats => ({ requests: 0, rows: 0, bytes: 0, failed: 0, ms: 0 });

type BucketRow = {
  pairing_name: string;
  bucket_start: string;
  readings: number;
  excluded: number;
  vwc_mean: number | null;
  raw_mean: number | null;
  temperature_mean: number | null;
  ec_mean: number | null;
};

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  }
  return out;
}

/**
 * Per-pot bucket aggregates for a window, in calls of at most 1000 rows (the API's page size).
 * A failed call is counted, not hidden: the caller reports incomplete data.
 */
export async function loadReadingBuckets(
  input: { projectId: string; deviceId: string; pairingNames: readonly string[]; window: Pick<ResolvedWindow, "queryStartMs" | "endMs" | "bucketMs">; exclusions: unknown[] },
  stats: FetchStats = emptyStats(),
) {
  const started = performance.now();
  const plan = bucketRequestPlan(input.pairingNames, input.window);
  const results = await inBatches(plan, 4, async (call) => {
    stats.requests += 1;
    const { data, error } = await supabase.rpc("portal_reading_buckets", {
      p_project_id: input.projectId,
      p_device_id: input.deviceId,
      p_pairing_names: call.pairingNames,
      p_start: new Date(call.startMs).toISOString(),
      p_end: new Date(call.endMs).toISOString(),
      p_bucket_seconds: Math.round(input.window.bucketMs / 1000),
      p_exclusions: input.exclusions,
    });
    if (error) {
      stats.failed += 1;
      return [] as BucketRow[];
    }
    const rows = (data ?? []) as BucketRow[];
    stats.rows += rows.length;
    stats.bytes += JSON.stringify(rows).length;
    return rows;
  });
  stats.ms += performance.now() - started;
  return results.flat().map((row): PotBucket => ({
    pairingName: row.pairing_name,
    startMs: Date.parse(row.bucket_start),
    readings: row.readings,
    excluded: row.excluded,
    values: { vwc: row.vwc_mean, raw: row.raw_mean, temperature: row.temperature_mean, ec: row.ec_mean },
  }));
}

export type ValveBucket = { pairingName: string; startMs: number; openings: number; commandedOpenMs: number };

/** Valve openings the controller recorded, per pot and bucket (controller events, not water). */
export async function loadValveOpenBuckets(
  input: { projectId: string; deviceId: string; pairingNames: readonly string[]; window: Pick<ResolvedWindow, "queryStartMs" | "endMs" | "bucketMs"> },
  stats: FetchStats = emptyStats(),
) {
  const plan = bucketRequestPlan(input.pairingNames, input.window);
  const results = await inBatches(plan, 4, async (call) => {
    stats.requests += 1;
    const { data, error } = await supabase.rpc("portal_valve_open_buckets", {
      p_project_id: input.projectId,
      p_device_id: input.deviceId,
      p_pairing_names: call.pairingNames,
      p_start: new Date(call.startMs).toISOString(),
      p_end: new Date(call.endMs).toISOString(),
      p_bucket_seconds: Math.round(input.window.bucketMs / 1000),
    });
    if (error) {
      stats.failed += 1;
      return [] as { pairing_name: string; bucket_start: string; openings: number; commanded_open_ms: number }[];
    }
    const rows = (data ?? []) as { pairing_name: string; bucket_start: string; openings: number; commanded_open_ms: number }[];
    stats.rows += rows.length;
    stats.bytes += JSON.stringify(rows).length;
    return rows;
  });
  return results.flat().map((row): ValveBucket => ({
    pairingName: row.pairing_name,
    startMs: Date.parse(row.bucket_start),
    openings: row.openings,
    commandedOpenMs: Number(row.commanded_open_ms) || 0,
  }));
}

import type { PortalExperiment, PortalExperimentAssignment } from "./experimentRegistry";

/**
 * Experiment factors come from the experiment's own assignments (current revision), never from a
 * hard-coded list of treatments. A factor exists when its column has at least two distinct
 * values across the assigned pots; every other column is a constant of the experiment.
 */
export type FactorKey = "treatment" | "crop" | "substrate" | "block";

export type FactorLevel = { value: string; label: string; potCount: number };
export type ExperimentFactor = { key: FactorKey; label: string; levels: FactorLevel[] };

export type GroupPattern = {
  /** Index into the shared group palette; colour is never the only encoding. */
  index: number;
  color: string;
  /** SVG stroke-dasharray, or null for a solid line. */
  dash: string | null;
  marker: "circle" | "square" | "triangle" | "diamond" | "ring" | "bar";
};

export type PotGroup = {
  id: string;
  label: string;
  /** Factor values that define the group, e.g. { treatment: "drought", crop: "maize" }. */
  levels: Partial<Record<FactorKey, string>>;
  pairingNames: string[];
  potNumbers: number[];
  /** Distinct planned targets in this group (experiment plan, not the controller). */
  plannedTargets: number[];
  pattern: GroupPattern;
};

const factorOrder: FactorKey[] = ["treatment", "crop", "substrate", "block"];
const factorLabels: Record<FactorKey, string> = {
  treatment: "Treatment",
  crop: "Crop",
  substrate: "Substrate",
  block: "Block",
};

// Distinguishable in colour, and again in dash and marker for colour-blind and greyscale reading.
const palette = ["#1f5f8b", "#b4531f", "#1a6b4a", "#6d3f87", "#8a6d0c", "#3d4a43"];
const dashes: (string | null)[] = [null, "6 4", "2 3", "9 3 2 3", "1 4", "12 4"];
const markers: GroupPattern["marker"][] = ["circle", "square", "triangle", "diamond", "ring", "bar"];

export function groupPattern(index: number): GroupPattern {
  const i = ((index % palette.length) + palette.length) % palette.length;
  return { index, color: palette[i], dash: dashes[i], marker: markers[i] };
}

function normalized(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

export function levelLabel(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "Not set";
  // Keep researchers' own capitalisation when they used any; otherwise sentence-case it.
  if (trimmed !== trimmed.toLowerCase()) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function orderedAssignments(assignments: readonly PortalExperimentAssignment[]) {
  return assignments.slice().sort((a, b) => a.zone - b.zone || a.pot_number - b.pot_number || a.pairing_name.localeCompare(b.pairing_name));
}

/** Factors with two or more levels, in a stable order; levels in plan (first pot) order. */
export function experimentFactors(experiment: Pick<PortalExperiment, "assignments"> | null | undefined): ExperimentFactor[] {
  const assignments = orderedAssignments(experiment?.assignments ?? []);
  const factors: ExperimentFactor[] = [];
  for (const key of factorOrder) {
    const levels = new Map<string, FactorLevel>();
    for (const assignment of assignments) {
      const value = normalized(assignment[key]);
      const id = value.toLowerCase();
      const current = levels.get(id);
      if (current) current.potCount += 1;
      else levels.set(id, { value, label: levelLabel(value), potCount: 1 });
    }
    const named = Array.from(levels.values()).filter((level) => level.value);
    if (named.length >= 2) factors.push({ key, label: factorLabels[key], levels: Array.from(levels.values()) });
  }
  return factors;
}

/** Treatment × crop when both vary, otherwise the first factor, otherwise one group of all pots. */
export function defaultGrouping(factors: readonly ExperimentFactor[]): FactorKey[] {
  const keys = new Set(factors.map((factor) => factor.key));
  if (keys.has("treatment") && keys.has("crop")) return ["treatment", "crop"];
  if (keys.has("treatment")) return ["treatment"];
  return factors.length ? [factors[0].key] : [];
}

/** Parse a grouping from the URL (`group=treatment,crop` or `group=none`), keeping only real factors. */
export function parseGrouping(value: string | null, factors: readonly ExperimentFactor[]): FactorKey[] {
  if (value == null) return defaultGrouping(factors);
  if (value === "none") return [];
  const available = new Set(factors.map((factor) => factor.key));
  const keys = value.split(",").map((part) => part.trim()).filter((part): part is FactorKey => available.has(part as FactorKey));
  return keys.length ? Array.from(new Set(keys)) : defaultGrouping(factors);
}

export function groupingLabel(grouping: readonly FactorKey[]) {
  return grouping.length ? grouping.map((key) => factorLabels[key]).join(" × ") : "All pots";
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";
}

/**
 * Groups of pots for a grouping. Pots listed on the experiment without an assignment (legacy or
 * incomplete specifications) are kept in an explicit "Not in the plan" group rather than dropped.
 */
export function potGroups(
  experiment: Pick<PortalExperiment, "assignments" | "pairingNames">,
  grouping: readonly FactorKey[],
): PotGroup[] {
  const assignments = orderedAssignments(experiment.assignments ?? []);
  const groups = new Map<string, Omit<PotGroup, "pattern">>();
  for (const assignment of assignments) {
    const levels: Partial<Record<FactorKey, string>> = {};
    for (const key of grouping) levels[key] = normalized(assignment[key]);
    // Match the case-insensitive factor levels, but preserve punctuation and tuple boundaries.
    // A display slug can collide ("A/B" vs "A B", or "a-b" × "c" vs "a" × "b-c").
    const key = JSON.stringify(grouping.map((factor) => [factor, (levels[factor] ?? "").toLowerCase()]));
    const id = grouping.length ? slug(grouping.map((key) => levels[key] || "not-set").join("-")) : "all";
    const current = groups.get(key) ?? {
      id,
      label: grouping.length ? grouping.map((key) => levelLabel(levels[key] ?? "")).join(" · ") : "All pots",
      levels,
      pairingNames: [],
      potNumbers: [],
      plannedTargets: [],
    };
    current.pairingNames.push(assignment.pairing_name);
    current.potNumbers.push(assignment.pot_number);
    const target = assignment.target_vwc_percent;
    if (typeof target === "number" && Number.isFinite(target) && !current.plannedTargets.some((value) => Math.abs(value - target) < 0.001)) {
      current.plannedTargets.push(target);
    }
    groups.set(key, current);
  }
  const legacyIdCounts = new Map<string, number>();
  for (const group of groups.values()) legacyIdCounts.set(group.id, (legacyIdCounts.get(group.id) ?? 0) + 1);
  for (const [key, group] of groups) {
    // Keep saved hidden-group IDs when they still identify exactly one real group. Ambiguous
    // legacy IDs cease to match either group, so an old saved figure cannot silently hide one.
    // The prefix cannot be emitted by slug(), and the full structured key is collision-free.
    if (legacyIdCounts.get(group.id) !== 1 || group.id === "not-in-plan") group.id = `group:${key}`;
  }
  const assigned = new Set(assignments.map((assignment) => assignment.pairing_name));
  const unassigned = experiment.pairingNames.filter((name) => !assigned.has(name));
  if (unassigned.length) {
    groups.set("not-in-plan", {
      id: "not-in-plan",
      label: assignments.length ? "Not in the plan" : "All pots",
      levels: {},
      pairingNames: unassigned.slice(),
      potNumbers: unassigned.map((name) => potNumberFromPairingName(name)).filter((value): value is number => value != null),
      plannedTargets: [],
    });
  }
  return Array.from(groups.values()).map((group, index) => ({ ...group, pattern: groupPattern(index) }));
}

/** Pot number from a controller pairing name such as "Zone2-Pot17". */
export function potNumberFromPairingName(name: string) {
  const match = /^Zone(\d+)-Pot(\d+)$/i.exec(name.trim());
  return match ? Number(match[2]) : null;
}

export function zoneFromPairingName(name: string) {
  const match = /^Zone(\d+)-Pot(\d+)$/i.exec(name.trim());
  return match ? Number(match[1]) : null;
}

/** "Pot 17", "Pots 17–24", "Pots 3, 11 and 20", "Pots 1–4, 9 and 12". */
export function potRangeText(potNumbers: readonly number[]) {
  const sorted = Array.from(new Set(potNumbers.filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
  if (!sorted.length) return "No pots";
  if (sorted.length === 1) return `Pot ${sorted[0]}`;
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const value of sorted.slice(1).concat(Number.NaN)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    parts.push(start === previous ? `${start}` : previous === start + 1 ? `${start}, ${previous}` : `${start}–${previous}`);
    start = value;
    previous = value;
  }
  const flat = parts.join(", ").split(", ");
  const text = flat.length > 1 ? `${flat.slice(0, -1).join(", ")} and ${flat[flat.length - 1]}` : flat[0];
  return `Pots ${text}`;
}

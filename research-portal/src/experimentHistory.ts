import type { PortalExperimentAssignment } from "./experimentRegistry";
import type { GapRow } from "./recordModel";

type HistoryIdentity = Pick<PortalExperimentAssignment, "pairing_name" | "sensor_key_snapshot">;

/** Resolve earlier labels only when an immutable revision ties them to the same full sensor key. */
export function experimentHistoryAliases(names: readonly string[], current: readonly HistoryIdentity[], history: readonly HistoryIdentity[]) {
  const aliases = new Map(names.map((name) => [name, name]));
  const candidates = new Map<string, Set<string>>();
  for (const old of history) {
    if (!old.sensor_key_snapshot) continue;
    for (const assignment of current) {
      if (!names.includes(assignment.pairing_name) || assignment.sensor_key_snapshot !== old.sensor_key_snapshot) continue;
      const matches = candidates.get(old.pairing_name) ?? new Set<string>();
      matches.add(assignment.pairing_name); candidates.set(old.pairing_name, matches);
    }
  }
  for (const [old, matches] of candidates) {
    if (!aliases.has(old) && matches.size === 1) aliases.set(old, [...matches][0]);
  }
  return aliases;
}

/** Combine hourly presence across renamed labels before deriving gaps after the first reading. */
export function gapsAcrossPairingAliases(
  buckets: readonly { pairingName: string; startMs: number; readings: number }[],
  aliases: ReadonlyMap<string, string>, startMs: number, endMs: number,
): GapRow[] {
  const hour = 3_600_000, complete = Math.floor((endMs - startMs) / hour);
  const present = new Map<string, Set<number>>();
  for (const bucket of buckets) {
    const name = aliases.get(bucket.pairingName);
    if (!name || bucket.readings <= 0) continue;
    const indexes = present.get(name) ?? new Set<number>();
    indexes.add(Math.floor((bucket.startMs - startMs) / hour)); present.set(name, indexes);
  }
  const gaps: GapRow[] = [];
  for (const [pairingName, indexes] of present) {
    const first = Math.min(...indexes); let run: number | null = null;
    for (let i = first; i <= complete; i += 1) {
      if (i < complete && !indexes.has(i)) { run ??= i; continue; }
      if (run != null && i - run >= 2) gaps.push({ pairingName, startMs: startMs + run * hour, endMs: startMs + i * hour, ongoing: i === complete });
      run = null;
    }
  }
  return gaps;
}

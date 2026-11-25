import {
  FIELD_MAP,
  normalizedValveKey,
} from "../_shared/installation-field-map.mjs";
export type Probe = { id: number; key: string };
export type Choice = { pot: number; group: string; target: number | null };
export type Match = {
  pot: number;
  name: string;
  sensorKey: string;
  valveKey: string;
  delta: number;
};
export type Sample = { v: number; raw?: number; t: number };
export type Rise = {
  key: string;
  delta: number;
  rawDelta: number;
  sustained: boolean;
  strong: boolean;
};
export type Setup = {
  name: string;
  mode: "calibration" | "controlled";
  curve: string;
  pots: Choice[];
};
export type Pair = {
  name: string;
  Sensor?: { boardSerialId: string; address: string };
  Valve?: { relayAddress: string; address: string };
};
export const route = (pot: number) => {
  const field = FIELD_MAP.find((row) =>
    row.pot === pot && row.status === "verified"
  );
  if (!field) {
    throw Error("Pot " + pot + " has no available verified valve route.");
  }
  return {
    key: "0x" + field.relayAddress!.toString(16) + ":" + field.channel,
    name: "Zone" + Math.ceil(pot / 25) + "-Pot" + String(pot).padStart(2, "0"),
  };
};
export function validateSetup(input: Setup) {
  if (
    !input || !input.name?.trim() || input.name.length > 120 ||
    !["calibration", "controlled"].includes(input.mode) ||
    !Array.isArray(input.pots) || !input.pots.length ||
    input.pots.length > 100 || !input.curve
  ) throw Error("Choose an experiment name, soil curve and pots.");
  const seen = new Set<number>();
  for (const p of input.pots) {
    route(p.pot);
    if (
      seen.has(p.pot) || !p.group?.trim() || p.group.length > 80 ||
      !(p.target === null ||
        (Number.isFinite(p.target) && p.target >= 0 && p.target <= 80))
    ) throw Error("Check each pot’s group and moisture target.");
    seen.add(p.pot);
  }
}
export function sensorId(p: Pair) {
  return p.Sensor ? p.Sensor.boardSerialId + ":" + p.Sensor.address : "";
}
export function valveId(p: Pair) {
  return p.Valve
    ? normalizedValveKey(p.Valve.relayAddress + ":" + p.Valve.address)
    : null;
}
function median(samples: number[]) {
  const values = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

export function rankResponses(
  before: Record<string, Sample[]>,
  after: Record<string, Sample[]>,
  keys: string[],
): Rise[] {
  const rises: Rise[] = [];
  for (const key of keys) {
    const pre = before[key] ?? [], post = after[key] ?? [];
    if (
      pre.length < 3 || !post.length ||
      [...pre, ...post].some((s) => s.raw == null || !Number.isFinite(s.raw))
    ) continue;
    const raw = pre.map((s) => s.raw!),
      base = median(raw),
      center = median(pre.map((s) => s.v));
    const rawDelta = median(post.map((s) => s.raw!)) - base;
    const delta = median(post.map((s) => s.v)) - center;
    if (delta <= 0 || !rawDelta) continue;
    // The same raw change can imply different VWC changes on different parts of the curve.
    const direction = Math.sign(rawDelta);
    const noise = Math.max(
      .01,
      Math.max(...raw) - Math.min(...raw),
      1.4826 * median(raw.map((v) => Math.abs(v - base))),
    );
    const sustained = post.length >= 3 &&
      post.every((s) =>
        s.v > center && (s.raw! - base) * direction >= Math.abs(rawDelta) * .5
      );
    rises.push({
      key,
      delta,
      rawDelta,
      sustained,
      strong: sustained && Math.abs(rawDelta) > 3 * noise,
    });
  }
  return rises.sort((a, b) => b.delta - a.delta);
}

export function clearResponse(rises: Rise[], complete: boolean): Rise | null {
  const best = rises[0];
  if (
    !complete || !best?.strong ||
    rises.slice(1).some((other) => other.delta >= .7 * best.delta)
  ) return null;
  return best;
}

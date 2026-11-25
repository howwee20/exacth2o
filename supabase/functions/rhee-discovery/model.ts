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
export type Sample = { v: number; t: number };
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
export function assess(
  before: Record<string, Sample[]>,
  after: Record<string, Sample[]>,
  keys: string[],
) {
  const median = (xs: number[]) => {
    const a = xs.slice().sort((a, b) => a - b);
    return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) /
      2;
  };
  const rises = keys.map((key) => {
    const a = before[key] ?? [], b = after[key] ?? [];
    if (a.length < 3 || b.length < 3) {
      throw Error(
        "A responding probe dropped out during measurement. No match was assigned.",
      );
    }
    const pre = a.map((x) => x.v),
      post = b.map((x) => x.v),
      center = median(pre);
    const noise = Math.max(
      .05,
      1.4826 * median(pre.map((x) => Math.abs(x - center))),
    );
    const delta = median(post) - center;
    return {
      key,
      delta,
      strong: delta >= .5 && delta >= 5 * noise &&
        Math.min(...post) >= center + delta * .5,
      rival: delta >= .25 && delta >= 3 * noise,
    };
  }).sort((a, b) => b.delta - a.delta);
  const best = rises[0];
  if (
    !best?.strong || best.delta > 10 ||
    rises.slice(1).some((r) => r.rival && r.delta >= .7 * best.delta)
  ) return null;
  return best;
}

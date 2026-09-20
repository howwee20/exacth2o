// Confidence for a proposed valve-to-sensor pairing. Shared by production
// commissioning and by the internal test simulator.

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export const defaultMinZ = 5;

// Confidence answers "how sure are we this is the ONLY plausible pairing?", so it
// is driven by the margin over rival sensors (row) and rival valves (column), and
// only then scaled by how strong the response was.
export function pairConfidence(
  input: { deltaVwc: number; z: number; rowRivalDeltaVwc: number; columnRivalDeltaVwc: number },
  config: { minZ: number } = { minZ: defaultMinZ },
) {
  if (!(input.deltaVwc > 0)) return 0;
  const strength = clamp01((input.z - config.minZ) / (3 * config.minZ));
  const rowMargin = clamp01(1 - input.rowRivalDeltaVwc / input.deltaVwc);
  const columnMargin = clamp01(1 - input.columnRivalDeltaVwc / input.deltaVwc);
  return clamp01((0.15 + 0.85 * strength) * Math.min(rowMargin, columnMargin));
}

export function confidenceLevel(confidence: number): "High" | "Medium" | "Low" {
  if (confidence >= 0.85) return "High";
  if (confidence >= 0.6) return "Medium";
  return "Low";
}

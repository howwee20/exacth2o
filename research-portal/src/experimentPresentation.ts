import type {
  PortalExperiment,
  PortalExperimentAssignment,
} from "./experimentRegistry";
import type { PairingRow } from "./types";

export type Treatment = "control" | "drought" | "unknown";
export type PlantGroup = "maize" | "sorghum" | "unknown";

export type ExperimentGraphGroup = {
  id: string;
  label: string;
  crop: string;
  treatment: string;
  target: number | null;
  pairingNames: string[];
  potNumbers: number[];
};

function normalized(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function title(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function assignmentForPairing(
  pairing: Pick<PairingRow, "name">,
  experiment?: PortalExperiment | null,
) {
  return experiment?.assignments?.find(
    (assignment) => assignment.pairing_name === pairing.name,
  ) ?? null;
}

export function treatmentForExperimentPairing(
  pairing: PairingRow,
  experiment?: PortalExperiment | null,
): Treatment {
  const assignment = assignmentForPairing(pairing, experiment);
  const value = normalized(assignment?.treatment);
  if (value === "control" || value === "drought") return value;
  const group = normalized(pairing.group_name);
  if (group.includes("control")) return "control";
  if (group.includes("drought")) return "drought";
  return "unknown";
}

export function plantGroupForExperimentPairing(
  pairing: PairingRow,
  experiment?: PortalExperiment | null,
): PlantGroup {
  const assignment = assignmentForPairing(pairing, experiment);
  const value = normalized(assignment?.crop);
  if (value === "maize" || value === "sorghum") return value;
  const group = normalized(pairing.group_name);
  if (group.includes("maize")) return "maize";
  if (group.includes("sorghum")) return "sorghum";
  return "unknown";
}

/** Crop identity comes from the experiment plan, independent of controller wiring zones. */
export function experimentSidebarGroups(
  pairings: readonly PairingRow[],
  experiment?: PortalExperiment | null,
) {
  const groups = new Map<string, { id: string; label: string; pairings: PairingRow[] }>();
  for (const pairing of pairings) {
    const assignment = assignmentForPairing(pairing, experiment);
    const legacyCrop = plantGroupForExperimentPairing(pairing, experiment);
    const crop = normalized(assignment?.crop) || (legacyCrop === "unknown" ? "" : legacyCrop);
    const id = crop ? `crop:${crop}` : "unassigned";
    const group = groups.get(id) ?? { id, label: crop ? title(crop) : "All pots", pairings: [] };
    group.pairings.push(pairing);
    groups.set(id, group);
  }
  if (groups.size > 1 && groups.has("unassigned")) groups.get("unassigned")!.label = "Other pots";
  return [...groups.values()]
    .map((group) => ({ ...group, pairings: group.pairings.slice().sort((a, b) => a.pot_number - b.pot_number || a.name.localeCompare(b.name)) }))
    .sort((a, b) => Number(a.id === "unassigned") - Number(b.id === "unassigned") || a.label.localeCompare(b.label));
}

export function experimentGraphGroups(
  experiment?: PortalExperiment | null,
): ExperimentGraphGroup[] {
  const groups = new Map<string, PortalExperimentAssignment[]>();
  for (const assignment of experiment?.assignments ?? []) {
    const crop = normalized(assignment.crop);
    const treatment = normalized(assignment.treatment);
    if (!crop || !treatment) continue;
    const key = `${crop}\u0000${treatment}`;
    const current = groups.get(key) ?? [];
    current.push(assignment);
    groups.set(key, current);
  }

  return Array.from(groups.entries())
    .map(([key, assignments]) => {
      const [crop, treatment] = key.split("\u0000");
      const targets = assignments
        .map((assignment) => assignment.target_vwc_percent)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const target = targets.length &&
          targets.every((value) => Math.abs(value - targets[0]) < 0.001)
        ? targets[0]
        : null;
      return {
        id: slug(`${crop}-${treatment}`),
        label: `${title(crop)} ${title(treatment)}`,
        crop,
        treatment,
        target,
        pairingNames: assignments
          .slice()
          .sort((left, right) => left.zone - right.zone || left.pot_number - right.pot_number)
          .map((assignment) => assignment.pairing_name),
        potNumbers: assignments
          .slice()
          .sort((left, right) => left.zone - right.zone || left.pot_number - right.pot_number)
          .map((assignment) => assignment.pot_number),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

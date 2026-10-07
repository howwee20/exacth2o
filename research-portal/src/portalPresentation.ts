import { type PlantGroup, plantGroupForExperimentPairing, type Treatment, treatmentForExperimentPairing } from "./experimentPresentation";
import { type PortalExperiment } from "./experimentRegistry";
import { colorForPotNumber } from "./potColors";
import { type PairingRow, type SensorReading } from "./types";

export function orderedPairings(pairings: PairingRow[]) {
  return pairings.slice().sort((a, b) => {
    if (a.zone !== b.zone) return a.zone - b.zone;
    if (a.pot_number !== b.pot_number) return a.pot_number - b.pot_number;
    return a.name.localeCompare(b.name);
  });
}

export function colorForPairing(pairing: PairingRow) {
  return colorForPotNumber(pairing.pot_number);
}

export function treatmentForPairing(
  pairing: PairingRow,
  experiment?: PortalExperiment | null,
): Treatment {
  return treatmentForExperimentPairing(pairing, experiment);
}

export function plantGroupForPairing(
  pairing: PairingRow,
  experiment?: PortalExperiment | null,
): PlantGroup {
  return plantGroupForExperimentPairing(pairing, experiment);
}

export function treatmentLabel(treatment: Treatment) {
  if (treatment === "control") return "Control";
  if (treatment === "drought") return "Drought";
  return "Unassigned";
}

export function plantGroupLabel(plantGroup: PlantGroup) {
  if (plantGroup === "maize") return "Maize";
  if (plantGroup === "sorghum") return "Sorghum";
  return "Unassigned";
}

export function metricValue(reading: SensorReading) {
  const value = reading.calibrated_value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(3));
}

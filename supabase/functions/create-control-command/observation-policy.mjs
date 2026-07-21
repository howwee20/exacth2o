const mattExperiment2Pairings = [
  ...Array.from({ length: 10 }, (_, index) => `Zone1-Pot${index + 15}`),
  "Zone1-Pot25", "Zone2-Pot26",
  ...Array.from({ length: 11 }, (_, index) => `Zone3-Pot${index + 65}`),
  "Zone4-Pot76",
];

const ovenDryPairings = [
  "Zone1-Pot02", "Zone1-Pot04", "Zone1-Pot06",
  ...Array.from({ length: 12 }, (_, index) => `Zone3-Pot${index + 51}`),
];

export const observationOnlyPairingNames = new Set([
  ...mattExperiment2Pairings,
  ...ovenDryPairings,
]);

export const observationOnlyGroupNames = new Set([
  "Matt Experiment 2 - Observation Only",
  "Matt Experiment 2 — Observation Only",
  "Oven-Dry Experiment - Observation Only",
  "Oven-Dry Experiment — Observation Only",
]);

function stringValues(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : typeof value === "string" ? [value] : [];
}

export function observationOnlyCommandDecision(commandType, payload = {}) {
  const pairingNames = [
    ...stringValues(payload.pairing_name),
    ...stringValues(payload.pairing_names),
    ...stringValues(payload.name),
  ];
  const groupNames = stringValues(payload.group_name);
  const referencesObservationOnly = pairingNames.some((name) =>
    observationOnlyPairingNames.has(name)
  ) || groupNames.some((name) => observationOnlyGroupNames.has(name));

  if (!referencesObservationOnly) return { allowed: true };

  const blockedTypes = new Set([
    "update_pairing",
    "bulk_update_pairings",
    "create_pairing",
    "create_group",
    "remove_group",
    "apply_calibration",
    "manual_water",
  ]);
  if (!blockedTypes.has(commandType)) return { allowed: true };

  return {
    allowed: false,
    status: 409,
    error: "This experiment is observation-only. ExactH2O watering and portal configuration changes are disabled.",
  };
}

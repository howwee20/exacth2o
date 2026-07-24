export const experimentDraftSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", maxLength: 300 },
    mode: { type: "string", enum: ["observation", "calibration"] },
    start_date: { type: ["string", "null"], maxLength: 40 },
    assignments: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pairing_name: { type: "string", minLength: 1, maxLength: 120 },
          crop: { type: ["string", "null"], maxLength: 80 },
          treatment: { type: ["string", "null"], maxLength: 80 },
          block: { type: ["string", "null"], maxLength: 80 },
          substrate: { type: ["string", "null"], maxLength: 80 },
          target_vwc_percent: {
            type: ["number", "null"],
            minimum: 0,
            maximum: 100,
          },
          measurement_interval_minutes: {
            type: ["number", "null"],
            minimum: 1,
            maximum: 1440,
          },
          notes: { type: ["string", "null"], maxLength: 300 },
        },
        required: [
          "pairing_name",
          "crop",
          "treatment",
          "block",
          "substrate",
          "target_vwc_percent",
          "measurement_interval_minutes",
          "notes",
        ],
      },
    },
    visibility_roles: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "string", enum: ["admin", "researcher"] },
    },
    watering_requested: { type: "boolean" },
    questions: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 180 },
    },
  },
  required: [
    "name",
    "description",
    "mode",
    "start_date",
    "assignments",
    "visibility_roles",
    "watering_requested",
    "questions",
  ],
};

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function nullableText(value, maxLength) {
  const cleaned = text(value, maxLength);
  return cleaned || null;
}

function nullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function inventoryFromDeviceConfig(configRow) {
  const row = record(configRow);
  const configPairings = Array.isArray(row.pairings) ? row.pairings : [];
  const configGroups = Array.isArray(row.groups) ? row.groups : [];
  const groupNames = new Map();

  for (const rawGroup of configGroups) {
    const group = record(rawGroup);
    const id = finiteNumber(group.id);
    const name = text(group.name, 120);
    if (id !== null && name) groupNames.set(id, name);
  }

  return configPairings.flatMap((rawPairing) => {
    const pairing = record(rawPairing);
    const name = text(pairing.name, 120);
    const label = /^Zone(\d+)-Pot(\d+)$/i.exec(name);
    const sensor = record(pairing.Sensor);
    const valve = record(pairing.Valve);
    const calibration = record(pairing.Calibration);
    const sensorBoard = text(sensor.boardSerialId, 120);
    const sensorAddress = text(sensor.address, 40);
    const relayAddress = text(valve.relayAddress, 120);
    const valveAddress = text(valve.address, 40);
    const groupId = finiteNumber(pairing.groupId);
    const target = finiteNumber(pairing.WTCPercentLimit);
    const openTime = finiteNumber(pairing.ValveOpenTime);
    const interval = finiteNumber(pairing.MeasurementInterval);

    if (
      !name || !label || !sensorBoard || !sensorAddress ||
      !relayAddress || !valveAddress || target === null ||
      openTime === null || interval === null
    ) return [];

    return [{
      name,
      zone: Number(label[1]),
      pot_number: Number(label[2]),
      group_name: groupId === null ? null : groupNames.get(groupId) ?? null,
      sensor_key: `${sensorBoard}:${sensorAddress}`,
      valve_key: `${relayAddress}:${valveAddress}`,
      calibration_name: nullableText(calibration.name, 160),
      wtc_percent_limit: target,
      valve_open_time_ms: openTime,
      measurement_interval_ms: interval,
    }];
  });
}

export function safeInventoryForModel(inventory) {
  return inventory.map((item) => ({
    pairing_name: item.name,
    zone: item.zone,
    pot_number: item.pot_number,
    group: item.group_name,
    calibration: item.calibration_name,
    current_target_vwc_percent: item.wtc_percent_limit,
    current_measurement_interval_minutes: item.measurement_interval_ms / 60_000,
  }));
}

export function normalizeDraft(value) {
  const draft = record(value);
  const assignments = Array.isArray(draft.assignments) ? draft.assignments : [];
  const questions = Array.isArray(draft.questions) ? draft.questions : [];

  return {
    name: text(draft.name, 120),
    description: text(draft.description, 300),
    mode: draft.mode === "calibration" ? "calibration" : "observation",
    start_date: nullableText(draft.start_date, 40),
    assignments: assignments.slice(0, 100).map((rawAssignment) => {
      const assignment = record(rawAssignment);
      return {
        pairing_name: text(assignment.pairing_name, 120),
        crop: nullableText(assignment.crop, 80),
        treatment: nullableText(assignment.treatment, 80),
        block: nullableText(assignment.block, 80),
        substrate: nullableText(assignment.substrate, 80),
        target_vwc_percent: nullableNumber(assignment.target_vwc_percent),
        measurement_interval_minutes: nullableNumber(
          assignment.measurement_interval_minutes,
        ),
        notes: nullableText(assignment.notes, 300),
      };
    }),
    visibility_roles: ["admin", "researcher"],
    watering_requested: draft.watering_requested === true,
    questions: questions
      .map((question) => text(question, 180))
      .filter(Boolean)
      .slice(0, 12),
  };
}

export function validateDraft(value, inventory) {
  const draft = normalizeDraft(value);
  const messages = [];
  const inventoryByName = new Map(inventory.map((item) => [item.name, item]));
  const pairingNames = new Set();
  const sensorKeys = new Set();
  const valveKeys = new Set();

  if (!draft.name) messages.push("Name is required.");
  if (draft.assignments.length < 1) messages.push("Select at least one pot.");
  if (draft.assignments.length > 100) {
    messages.push("An experiment can include at most 100 pots.");
  }
  if (draft.watering_requested) {
    messages.push("Watering cannot be enabled by the experiment builder.");
  }

  for (const assignment of draft.assignments) {
    const pairing = inventoryByName.get(assignment.pairing_name);
    if (!pairing) {
      messages.push(
        `${assignment.pairing_name || "Unknown pot"} is not in the current inventory.`,
      );
      continue;
    }
    if (pairingNames.has(pairing.name)) {
      messages.push(`${pairing.name} is selected more than once.`);
    }
    if (sensorKeys.has(pairing.sensor_key)) {
      messages.push(`${pairing.name} shares a sensor with another selected pot.`);
    }
    if (valveKeys.has(pairing.valve_key)) {
      messages.push(`${pairing.name} shares a valve with another selected pot.`);
    }
    pairingNames.add(pairing.name);
    sensorKeys.add(pairing.sensor_key);
    valveKeys.add(pairing.valve_key);

    if (
      assignment.target_vwc_percent !== null &&
      (assignment.target_vwc_percent < 0 || assignment.target_vwc_percent > 100)
    ) messages.push(`${pairing.name} has an invalid target.`);
    if (
      assignment.measurement_interval_minutes !== null &&
      (
        assignment.measurement_interval_minutes < 1 ||
        assignment.measurement_interval_minutes > 1440
      )
    ) messages.push(`${pairing.name} has an invalid measurement interval.`);
  }

  return { draft, messages: [...new Set(messages)] };
}

export function systemInstructions() {
  return [
    "Convert the researcher's request into an ExactH2O experiment draft.",
    "Only use pairing_name values from the supplied inventory.",
    "Do not invent pots, sensors, valves, pairings, calibrations, or mappings.",
    "This builder publishes sensing-only portal experiments.",
    "Never enable watering or claim that controller settings will change.",
    "Set watering_requested true if the researcher asks for any watering, target control, valve action, or controller change; the application will block publication.",
    "Use null for unspecified assignment metadata.",
    "Use questions for missing or ambiguous information that materially affects the draft.",
    "Keep the name and description concise.",
    "Return only the required structured result.",
  ].join("\n");
}

export function userDraftInput(prompt, inventory) {
  return [
    `Researcher request:\n${prompt}`,
    `Current allowed inventory:\n${JSON.stringify(safeInventoryForModel(inventory))}`,
  ].join("\n\n");
}

export function responseOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  for (const output of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if (content?.type === "refusal" && typeof content.refusal === "string") {
        throw new Error(content.refusal);
      }
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  throw new Error("The model returned no experiment draft.");
}

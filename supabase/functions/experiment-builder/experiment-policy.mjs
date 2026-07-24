export const experimentDraftSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", maxLength: 300 },
    mode: { type: "string", enum: ["controlled", "observation", "calibration"] },
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
          watering_enabled: { type: "boolean" },
          target_vwc_percent: {
            type: ["number", "null"],
            minimum: 0,
            maximum: 80,
          },
          valve_open_seconds: {
            type: ["number", "null"],
            minimum: 1,
            maximum: 120,
          },
          measurement_interval_minutes: {
            type: ["number", "null"],
            minimum: 0.5,
            maximum: 60,
          },
          notes: { type: ["string", "null"], maxLength: 300 },
        },
        required: [
          "pairing_name",
          "crop",
          "treatment",
          "block",
          "substrate",
          "watering_enabled",
          "target_vwc_percent",
          "valve_open_seconds",
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
    controller_changes_requested: { type: "boolean" },
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
    "controller_changes_requested",
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
    current_watering_enabled: item.wtc_percent_limit > -1_000,
    current_target_vwc_percent: item.wtc_percent_limit,
    current_valve_open_seconds: item.valve_open_time_ms / 1_000,
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
    mode: draft.mode === "controlled"
      ? "controlled"
      : draft.mode === "calibration"
        ? "calibration"
        : "observation",
    start_date: nullableText(draft.start_date, 40),
    assignments: assignments.slice(0, 100).map((rawAssignment) => {
      const assignment = record(rawAssignment);
      return {
        pairing_name: text(assignment.pairing_name, 120),
        crop: nullableText(assignment.crop, 80),
        treatment: nullableText(assignment.treatment, 80),
        block: nullableText(assignment.block, 80),
        substrate: nullableText(assignment.substrate, 80),
        watering_enabled: assignment.watering_enabled === true,
        target_vwc_percent: nullableNumber(assignment.target_vwc_percent),
        valve_open_seconds: nullableNumber(assignment.valve_open_seconds),
        measurement_interval_minutes: nullableNumber(
          assignment.measurement_interval_minutes,
        ),
        notes: nullableText(assignment.notes, 300),
      };
    }),
    visibility_roles: ["admin", "researcher"],
    controller_changes_requested: draft.controller_changes_requested === true,
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
  if (
    draft.start_date
    && Number.isFinite(Date.parse(draft.start_date))
    && Date.parse(draft.start_date) > Date.now() + 5 * 60_000
  ) {
    messages.push(
      "Future execution is not available yet. Create the experiment when it is ready to start.",
    );
  }
  if (draft.assignments.length < 1) messages.push("Select at least one pot.");
  if (draft.assignments.length > 100) {
    messages.push("An experiment can include at most 100 pots.");
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

    if (draft.mode === "observation" && assignment.watering_enabled) {
      messages.push(`${pairing.name} cannot water in an observation experiment.`);
    }
    if (assignment.watering_enabled && assignment.target_vwc_percent === null) {
      messages.push(`${pairing.name} needs a target before watering can be enabled.`);
    }
    if (
      assignment.target_vwc_percent !== null &&
      (assignment.target_vwc_percent < 0 || assignment.target_vwc_percent > 80)
    ) messages.push(`${pairing.name} has an invalid target.`);
    if (assignment.watering_enabled && assignment.valve_open_seconds === null) {
      messages.push(`${pairing.name} needs a valve time before watering can be enabled.`);
    }
    if (
      assignment.valve_open_seconds !== null &&
      (assignment.valve_open_seconds < 1 || assignment.valve_open_seconds > 120)
    ) messages.push(`${pairing.name} has an invalid valve time.`);
    if (assignment.measurement_interval_minutes === null) {
      messages.push(`${pairing.name} needs a measurement interval.`);
    }
    if (
      assignment.measurement_interval_minutes !== null &&
      (
        assignment.measurement_interval_minutes < 0.5 ||
        assignment.measurement_interval_minutes > 60
      )
    ) messages.push(`${pairing.name} has an invalid measurement interval.`);
  }

  return { draft, messages: [...new Set(messages)] };
}

function rounded(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sameNumber(left, right, tolerance = 0.0001) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

export function compileControlPlan(value, inventory, idFactory = () => crypto.randomUUID()) {
  const { draft, messages } = validateDraft(value, inventory);
  if (messages.length) return { draft, messages, plan: null };

  const inventoryByName = new Map(inventory.map((item) => [item.name, item]));
  const grouped = new Map();

  for (const assignment of draft.assignments) {
    const current = inventoryByName.get(assignment.pairing_name);
    const measurementIntervalMinutes = assignment.measurement_interval_minutes;
    const wateringEnabled = draft.mode !== "observation" && assignment.watering_enabled;
    const target = wateringEnabled ? assignment.target_vwc_percent : null;
    const valveSeconds = wateringEnabled ? assignment.valve_open_seconds : null;
    const currentWateringEnabled = current.wtc_percent_limit > -1_000;
    const changed = currentWateringEnabled !== wateringEnabled
      || (wateringEnabled && !sameNumber(current.wtc_percent_limit, target))
      || (wateringEnabled && !sameNumber(current.valve_open_time_ms / 1_000, valveSeconds))
      || !sameNumber(current.measurement_interval_ms / 60_000, measurementIntervalMinutes);
    if (!changed) continue;

    const settings = {
      watering_enabled: wateringEnabled,
      target_vwc_percent: target,
      valve_open_seconds: valveSeconds,
      measurement_interval_minutes: measurementIntervalMinutes,
    };
    const key = JSON.stringify(settings);
    const entry = grouped.get(key) ?? {
      ...settings,
      pairing_names: [],
      previous: [],
    };
    entry.pairing_names.push(current.name);
    entry.previous.push({
      pairing_name: current.name,
      watering_enabled: currentWateringEnabled,
      target_vwc_percent: currentWateringEnabled ? current.wtc_percent_limit : null,
      valve_open_seconds: rounded(current.valve_open_time_ms / 1_000),
      measurement_interval_minutes: rounded(current.measurement_interval_ms / 60_000),
    });
    grouped.set(key, entry);
  }

  const changes = [...grouped.values()];
  const commands = [];
  if (changes.length) {
    commands.push({
      label: "Pause controller",
      command_type: "update_system_state",
      payload: {
        state: "stopped",
        reason: `Apply reviewed settings for ${draft.name}`,
      },
      confirm: true,
      client_request_id: idFactory(),
    });
    for (const change of changes) {
      const payload = {
        pairing_names: change.pairing_names,
        measurement_interval_seconds: Math.round(change.measurement_interval_minutes * 60),
      };
      if (change.watering_enabled) {
        payload.target_vwc = change.target_vwc_percent;
        payload.open_time_seconds = change.valve_open_seconds;
      } else {
        payload.disable_watering = true;
      }
      commands.push({
        label: `Update ${change.pairing_names.length} pot${change.pairing_names.length === 1 ? "" : "s"}`,
        command_type: "bulk_update_pairings",
        payload,
        confirm: false,
        client_request_id: idFactory(),
      });
    }
    commands.push({
      label: "Resume sensing and control",
      command_type: "update_system_state",
      payload: {
        state: "running",
        reason: `Start reviewed experiment ${draft.name}`,
      },
      confirm: true,
      client_request_id: idFactory(),
    });
  }

  return {
    draft: {
      ...draft,
      controller_changes_requested: changes.length > 0,
    },
    messages: [],
    plan: {
      requires_controller_stop: changes.length > 0,
      final_controller_state: "running",
      change_count: changes.reduce((count, change) => count + change.pairing_names.length, 0),
      pairing_count: draft.assignments.length,
      changes,
      commands,
    },
  };
}

export function systemInstructions() {
  return [
    "Convert the researcher's request into an ExactH2O experiment draft.",
    "Only use pairing_name values from the supplied inventory.",
    "Do not invent pots, sensors, valves, pairings, calibrations, or mappings.",
    "The draft may configure sensing and routine per-pot watering controls.",
    "Use controlled mode when the researcher requests target moisture or watering.",
    "Use observation mode when watering must be disabled while sensing continues.",
    "For a fake, practice, demo, or test experiment, use observation mode with watering disabled unless the researcher explicitly requests real controller changes.",
    "For controlled assignments, provide watering_enabled, target_vwc_percent from 0 to 80, valve_open_seconds from 1 to 120, and measurement_interval_minutes from 0.5 to 60.",
    "For observation assignments, set watering_enabled false and target_vwc_percent and valve_open_seconds null.",
    "Use current inventory settings when the researcher does not specify a controller setting.",
    "Set controller_changes_requested true when any requested setting differs from current inventory.",
    "Never propose manual valve pulses, board configuration, sensor initialization, pairing rewiring, or calibration mutation.",
    "start_date records experiment metadata only; it does not schedule controller execution.",
    "If the request asks for a future start, a time-of-day action, or a one-time watering pulse, leave start_date null and add a concise question explaining that scheduled execution is not available.",
    "Use null only for unspecified descriptive metadata.",
    "Use questions for missing or ambiguous information that materially affects the draft.",
    "Keep the name and description concise.",
    "Return only the required structured result.",
  ].join("\n");
}

/**
 * @param {string} prompt
 * @param {Array<Record<string, unknown>>} inventory
 * @param {unknown} currentDraft
 */
export function userDraftInput(prompt, inventory, currentDraft = null) {
  const sections = [
    `Researcher request:\n${prompt}`,
    `Current allowed inventory:\n${JSON.stringify(safeInventoryForModel(inventory))}`,
  ];
  if (currentDraft) {
    sections.push(
      `Current reviewed draft to revise:\n${JSON.stringify(normalizeDraft(currentDraft))}`,
      "Apply the new request to the current draft. Preserve details that were not changed.",
    );
  }
  return sections.join("\n\n");
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

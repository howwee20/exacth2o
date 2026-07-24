export const settingsPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 240 },
    commands: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          command_type: {
            type: "string",
            enum: [
              "update_pairing",
              "bulk_update_pairings",
              "create_pairing",
              "delete_pairing",
              "create_group",
              "remove_group",
              "create_calibration",
              "delete_calibration",
              "apply_calibration",
              "update_board_config",
              "update_system_state",
              "export_data",
            ],
          },
          payload_json: { type: "string", minLength: 2, maxLength: 12_000 },
          effect: { type: "string", minLength: 1, maxLength: 240 },
        },
        required: ["command_type", "payload_json", "effect"],
      },
    },
    questions: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 180 },
    },
  },
  required: ["summary", "commands", "questions"],
};

const commandTypes = new Set(settingsPlanSchema.properties.commands.items.properties.command_type.enum);
const adminOnlyCommandTypes = new Set([
  "create_calibration",
  "delete_calibration",
  "apply_calibration",
  "update_board_config",
  "delete_pairing",
]);
const exportTypes = new Set([
  "readings",
  "groups",
  "sensors",
  "valves",
  "pairings",
  "calibrations",
]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberInRange(value, min, max, label) {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function exactString(value, allowed, label, maxLength = 160) {
  const cleaned = text(value, maxLength);
  if (!cleaned || !allowed.has(cleaned)) throw new Error(`${label} is not in the current controller inventory.`);
  return cleaned;
}

function newPairingName(value) {
  const cleaned = text(value, 120);
  if (!/^Zone\d+-Pot\d+$/i.test(cleaned)) {
    throw new Error("Pairing names must use Zone<number>-Pot<number>.");
  }
  return cleaned;
}

function stringList(value, allowed, label, maxItems = 100) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new Error(`${label} must contain 1-${maxItems} current items.`);
  }
  const cleaned = value.map((item) => exactString(item, allowed, label, 120));
  if (new Set(cleaned).size !== cleaned.length) throw new Error(`${label} contains a duplicate.`);
  return cleaned;
}

function currentHardwareKey(item, kind) {
  const row = record(item);
  if (kind === "sensor") {
    const board = text(row.boardSerialId ?? row.board_serial_id, 120);
    const address = text(row.address, 40);
    return board && address ? `${board}:${address}` : "";
  }
  const relay = text(row.relayAddress ?? row.relay_address, 120);
  const address = text(row.address, 40);
  return relay && address ? `${relay}:${address}` : "";
}

export function settingsInventoryFromDeviceConfig(configRow) {
  const row = record(configRow);
  const pairings = Array.isArray(row.pairings) ? row.pairings : [];
  const groups = Array.isArray(row.groups) ? row.groups : [];
  const calibrations = Array.isArray(row.calibrations) ? row.calibrations : [];
  const sensors = Array.isArray(row.sensors) ? row.sensors : [];
  const valves = Array.isArray(row.valves) ? row.valves : [];
  const boards = Array.isArray(row.board_config) ? row.board_config : [];

  return {
    pairings: pairings.map((item) => text(record(item).name, 120)).filter(Boolean),
    groups: groups.map((item) => text(record(item).name, 120)).filter(Boolean),
    calibrations: calibrations.map((item) => text(record(item).name, 160)).filter(Boolean),
    sensors: sensors.map((item) => currentHardwareKey(item, "sensor")).filter(Boolean),
    valves: valves.map((item) => currentHardwareKey(item, "valve")).filter(Boolean),
    boards: boards.map((item) => {
      const board = record(item);
      return {
        address: text(board.address, 16),
        reset_pin: finiteNumber(board.resetPin ?? board.reset_pin),
      };
    }).filter((item) => item.address),
  };
}

function targetSettings(payload) {
  const output = {};
  if ("target_vwc" in payload) output.target_vwc = numberInRange(payload.target_vwc, 0, 80, "Target VWC");
  if ("disable_watering" in payload) output.disable_watering = payload.disable_watering === true;
  if ("open_time_seconds" in payload) {
    output.open_time_seconds = numberInRange(payload.open_time_seconds, 1, 120, "Valve open time");
  }
  if ("measurement_interval_seconds" in payload) {
    output.measurement_interval_seconds = numberInRange(
      payload.measurement_interval_seconds,
      30,
      3600,
      "Measurement interval",
    );
  }
  return output;
}

export function normalizeSettingsPlan(value, configRow, role) {
  const rawPlan = record(value);
  const rawCommands = Array.isArray(rawPlan.commands) ? rawPlan.commands : [];
  const inventory = settingsInventoryFromDeviceConfig(configRow);
  const pairingNames = new Set(inventory.pairings);
  const groupNames = new Set(inventory.groups);
  const calibrationNames = new Set(inventory.calibrations);
  const sensorKeys = new Set(inventory.sensors);
  const valveKeys = new Set(inventory.valves);
  const errors = [];
  const commands = [];

  for (const item of rawCommands.slice(0, 20)) {
    try {
      const command = record(item);
      const commandType = text(command.command_type, 60);
      if (!commandTypes.has(commandType)) throw new Error("The requested setting is not supported.");
      if (adminOnlyCommandTypes.has(commandType) && role !== "admin") {
        throw new Error(`${commandType.replaceAll("_", " ")} requires administrator access.`);
      }
      const payload = record(JSON.parse(text(command.payload_json, 12_000)));
      let normalized = {};

      if (commandType === "update_pairing") {
        const pairingName = exactString(payload.pairing_name, pairingNames, "Pairing", 120);
        const newName = "new_name" in payload ? newPairingName(payload.new_name) : "";
        const pairingSettings = targetSettings(payload);
        if (newName) {
          if (newName !== pairingName && pairingNames.has(newName)) {
            throw new Error("The new pairing name is already in use.");
          }
          pairingSettings.new_name = newName;
        }
        if ("group_name" in payload) {
          pairingSettings.group_name = exactString(payload.group_name, groupNames, "Group", 120);
        }
        if (!Object.keys(pairingSettings).length) {
          throw new Error("A pairing update needs a name, group, target, watering state, valve time, or measurement interval.");
        }
        normalized = {
          pairing_name: pairingName,
          ...pairingSettings,
        };
      } else if (commandType === "bulk_update_pairings") {
        const pairingSettings = targetSettings(payload);
        if ("group_name" in payload) {
          pairingSettings.group_name = exactString(payload.group_name, groupNames, "Group", 120);
        }
        if (!Object.keys(pairingSettings).length) {
          throw new Error("A bulk pairing update needs a group, target, watering state, valve time, or measurement interval.");
        }
        normalized = {
          pairing_names: stringList(payload.pairing_names, pairingNames, "Pairings"),
          ...pairingSettings,
        };
      } else if (commandType === "create_pairing") {
        const name = newPairingName(payload.name);
        if (!name || pairingNames.has(name)) throw new Error("New pairing name is missing or already in use.");
        normalized = {
          name,
          sensor_key: exactString(payload.sensor_key, sensorKeys, "Sensor", 120),
          valve_key: exactString(payload.valve_key, valveKeys, "Valve", 120),
          group_name: exactString(payload.group_name, groupNames, "Group", 120),
          target_vwc: numberInRange(payload.target_vwc, 0, 80, "Target VWC"),
          open_time_seconds: numberInRange(payload.open_time_seconds, 1, 120, "Valve open time"),
          measurement_interval_seconds: numberInRange(
            payload.measurement_interval_seconds,
            30,
            3600,
            "Measurement interval",
          ),
        };
      } else if (commandType === "delete_pairing") {
        normalized = {
          pairing_name: exactString(payload.pairing_name, pairingNames, "Pairing", 120),
        };
      } else if (commandType === "create_group") {
        const groupName = text(payload.group_name, 120);
        if (!groupName || groupNames.has(groupName)) throw new Error("New group name is missing or already in use.");
        const groupType = text(payload.group_type, 20).toLowerCase() || "none";
        if (!["none", "group", "block"].includes(groupType)) {
          throw new Error("Group type must be none, group, or block.");
        }
        normalized = { group_name: groupName, group_type: groupType };
      } else if (commandType === "remove_group") {
        normalized = { group_name: exactString(payload.group_name, groupNames, "Group", 120) };
      } else if (commandType === "create_calibration") {
        const name = text(payload.name, 160);
        const functionText = text(payload.function_text, 400);
        if (!name || calibrationNames.has(name)) throw new Error("New calibration name is missing or already in use.");
        if (!functionText) throw new Error("A reviewed calibration equation is required.");
        normalized = { name, mode: "manual", function_text: functionText };
      } else if (commandType === "delete_calibration") {
        normalized = {
          calibration_name: exactString(payload.calibration_name, calibrationNames, "Calibration", 160),
        };
      } else if (commandType === "apply_calibration") {
        normalized = {
          calibration_name: exactString(payload.calibration_name, calibrationNames, "Calibration", 160),
          pairing_names: stringList(payload.pairing_names, pairingNames, "Pairings"),
        };
      } else if (commandType === "update_board_config") {
        if (!Array.isArray(payload.boards) || payload.boards.length < 1 || payload.boards.length > 12) {
          throw new Error("Board configuration must contain 1-12 boards.");
        }
        normalized = {
          boards: payload.boards.map((item) => {
            const board = record(item);
            const address = text(board.address, 16);
            if (!/^0x[0-9a-f]{1,2}$/i.test(address)) throw new Error("Board addresses must be hexadecimal.");
            return {
              address,
              reset_pin: Math.round(numberInRange(board.reset_pin, 0, 40, "Reset pin")),
            };
          }),
        };
      } else if (commandType === "update_system_state") {
        const state = text(payload.state, 40).toLowerCase();
        if (state !== "running" && state !== "stopped") throw new Error("System state must be running or stopped.");
        normalized = { state, reason: text(payload.reason, 300) || "Reviewed assistant request" };
      } else if (commandType === "export_data") {
        const dataType = text(payload.data_type, 60);
        if (!exportTypes.has(dataType)) throw new Error("That export is not available in the synchronized portal.");
        normalized = { data_type: dataType };
      }

      commands.push({
        command_type: commandType,
        payload: normalized,
        effect: text(command.effect, 240) || commandType.replaceAll("_", " "),
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "A requested setting is invalid.");
    }
  }

  const questions = (Array.isArray(rawPlan.questions) ? rawPlan.questions : [])
    .map((item) => text(item, 180))
    .filter(Boolean)
    .slice(0, 10);
  return {
    plan: {
      summary: text(rawPlan.summary, 240) || "Review requested settings",
      commands,
      questions,
    },
    errors,
  };
}

export function settingsSystemInstructions(role) {
  return [
    "Convert the request into a reviewed ExactH2O settings plan.",
    `The signed-in portal role is ${role}.`,
    "Use only exact names and hardware keys from the supplied current inventory.",
    "Never invent a pairing, sensor, valve, group, calibration, or board.",
    "Return no commands and ask a concise question when a material value or target is missing.",
    "Do not create an experiment tile; these commands modify existing system settings.",
    "Manual valve pulses and sensor initialization are locked and must never be proposed.",
    "Researchers cannot create, delete, or apply calibrations and cannot change board configuration.",
    "Command payload JSON grammar:",
    'update_pairing: {"pairing_name":string, optional "new_name":string, "group_name":existing string, "target_vwc":0..80, "disable_watering":boolean, "open_time_seconds":1..120, "measurement_interval_seconds":30..3600}.',
    'bulk_update_pairings: {"pairing_names":[string], optional existing "group_name" and target/watering/time fields}.',
    'create_pairing: {"name":string,"sensor_key":string,"valve_key":string,"group_name":string,"target_vwc":number,"open_time_seconds":number,"measurement_interval_seconds":number}.',
    'delete_pairing: {"pairing_name":string}; administrator only and destructive.',
    'create_group: {"group_name":string,"group_type":"none"|"group"|"block"}; remove_group: {"group_name":string}.',
    'create_calibration: {"name":string,"function_text":string}.',
    'delete_calibration: {"calibration_name":string}.',
    'apply_calibration: {"calibration_name":string,"pairing_names":[string]}.',
    'update_board_config: {"boards":[{"address":"0x20","reset_pin":16}]}.',
    'update_system_state: {"state":"running"|"stopped","reason":string}.',
    'export_data: {"data_type":"readings"|"groups"|"sensors"|"valves"|"pairings"|"calibrations"}.',
    "payload_json must be valid compact JSON matching the selected command.",
    "Keep the summary, effects, and questions concise.",
  ].join("\n");
}

/**
 * @param {string} prompt
 * @param {unknown} configRow
 * @param {unknown} currentPlan
 */
export function settingsUserInput(prompt, configRow, currentPlan = null) {
  const inventory = settingsInventoryFromDeviceConfig(configRow);
  const sections = [
    `Settings request:\n${prompt}`,
    `Current controller inventory:\n${JSON.stringify(inventory)}`,
  ];
  if (currentPlan) {
    sections.push(
      `Current reviewed plan:\n${JSON.stringify(currentPlan)}`,
      "Revise the current plan. Preserve commands not changed by the new request.",
    );
  }
  return sections.join("\n\n");
}

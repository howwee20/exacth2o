import { normalizeSettingsPlan } from "./settings-policy.mjs";

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function finiteNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTime(value) {
  const cleaned = text(value, 80);
  return cleaned && Number.isFinite(Date.parse(cleaned)) ? cleaned : null;
}

function validTimeZone(value) {
  const zone = text(value, 80);
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const scheduleCommandTypes = new Set([
  "update_pairing",
  "bulk_update_pairings",
  "update_system_state",
]);

export const schedulePlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    run_at: { type: "string", minLength: 1, maxLength: 80 },
    recurrence: {
      type: "string",
      enum: ["once", "daily", "weekly"],
    },
    timezone: { type: "string", minLength: 1, maxLength: 80 },
    settings_plan: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 240 },
        commands: {
          type: "array",
          minItems: 1,
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
                  "update_system_state",
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
    },
    questions: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 180 },
    },
  },
  required: [
    "name",
    "run_at",
    "recurrence",
    "timezone",
    "settings_plan",
    "questions",
  ],
};

export function normalizeSchedulePlan(value, configRow, role, now = new Date()) {
  const raw = record(value);
  const runAt = isoTime(raw.run_at);
  const recurrence = ["once", "daily", "weekly"].includes(raw.recurrence)
    ? raw.recurrence
    : "once";
  const questions = Array.isArray(raw.questions)
    ? raw.questions.map((item) => text(item, 180)).filter(Boolean).slice(0, 10)
    : [];
  const requestedCommands = Array.isArray(record(raw.settings_plan).commands)
    ? record(raw.settings_plan).commands
    : [];
  const normalizedSettings = normalizeSettingsPlan(raw.settings_plan, configRow, role);
  const commands = normalizedSettings.plan.commands.filter((command) =>
    scheduleCommandTypes.has(command.command_type)
  );

  if (
    normalizedSettings.plan.commands.length !== commands.length ||
    requestedCommands.some((command) =>
      !scheduleCommandTypes.has(text(record(command).command_type, 80))
    )
  ) {
    questions.push(
      "Scheduled actions currently support target, watering-state, cadence, and controller run/stop changes only.",
    );
  }
  questions.push(...normalizedSettings.plan.questions, ...normalizedSettings.errors);
  if (!runAt) {
    questions.push("Choose a valid date and time for this schedule.");
  } else if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(runAt)) {
    questions.push("The scheduled time must include an explicit UTC offset.");
  } else {
    const delay = Date.parse(runAt) - now.getTime();
    if (delay < 60_000) questions.push("Schedule the action at least one minute in the future.");
    if (delay > 366 * 24 * 60 * 60 * 1_000) {
      questions.push("Schedules can be created up to one year in advance.");
    }
  }
  const timezone = text(raw.timezone, 80) || "UTC";
  if (!validTimeZone(timezone)) {
    questions.push("Choose a valid IANA timezone for this schedule.");
  }
  if (
    commands.some((command) => command.command_type === "update_system_state") &&
    (commands.length !== 1 || recurrence !== "once")
  ) {
    questions.push("A controller run or stop request must be a one-time schedule reviewed by itself.");
  }

  return {
    plan: {
      name: text(raw.name, 120) || "Scheduled change",
      run_at: runAt,
      recurrence,
      timezone,
      settings_plan: {
        summary: normalizedSettings.plan.summary,
        commands,
        questions: normalizedSettings.plan.questions,
      },
      questions: [...new Set(questions)].slice(0, 10),
    },
  };
}

export function scheduleSystemInstructions(role, nowIso, timezone) {
  return [
    "Convert the request into one reviewed ExactH2O schedule.",
    `The signed-in role is ${role}. Current time is ${nowIso}. The browser timezone is ${timezone}.`,
    "Return run_at as an ISO-8601 timestamp with an explicit UTC offset.",
    "Use recurrence once, daily, or weekly.",
    "Only schedule update_pairing, bulk_update_pairings, or update_system_state.",
    "Do not schedule manual watering, sensor initialization, pairing creation or deletion, groups, calibrations, or board changes.",
    "A controller run or stop request must be a one-time schedule and the only command.",
    "Use exact current pairing names. Never invent hardware or settings.",
    "If timing, pairings, targets, or cadence are materially ambiguous, return no commands and ask one concise question.",
    "Scheduled configuration changes will be revalidated against fresh inventory and controller state before execution.",
    "Keep names, effects, and questions concise.",
  ].join("\n");
}

/**
 * @param {unknown} currentPlan
 */
export function scheduleUserInput(prompt, configRow, timezone, currentPlan = null) {
  const sections = [
    `Schedule request:\n${text(prompt, 4_000)}`,
    `Browser timezone:\n${text(timezone, 80) || "UTC"}`,
    `Current synchronized controller configuration:\n${JSON.stringify({
      pairings: Array.isArray(record(configRow).pairings)
        ? record(configRow).pairings
        : [],
      groups: Array.isArray(record(configRow).groups) ? record(configRow).groups : [],
      updated_at: record(configRow).updated_at ?? null,
    })}`,
  ];
  if (currentPlan) {
    sections.push(`Current reviewed draft to revise:\n${JSON.stringify(currentPlan)}`);
  }
  return sections.join("\n\n");
}

export const monitorPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    experiment: { type: ["string", "null"], maxLength: 160 },
    metric: {
      type: "string",
      enum: ["current_vwc", "change_vwc", "sensor_stale", "controller_health"],
    },
    comparator: {
      type: "string",
      enum: ["above", "below", "increase_by", "decrease_by", "stale", "unhealthy"],
    },
    threshold: { type: ["number", "null"], minimum: 0, maximum: 100 },
    window_minutes: { type: "number", minimum: 5, maximum: 10_080 },
    pairing_names: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 120 },
    },
    check_every_minutes: { type: "number", minimum: 5, maximum: 1_440 },
    cooldown_minutes: { type: "number", minimum: 5, maximum: 10_080 },
    questions: {
      type: "array",
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 180 },
    },
  },
  required: [
    "name",
    "experiment",
    "metric",
    "comparator",
    "threshold",
    "window_minutes",
    "pairing_names",
    "check_every_minutes",
    "cooldown_minutes",
    "questions",
  ],
};

function exactExperiment(catalog, requested) {
  const query = text(requested, 160).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!query) return null;
  const matches = (Array.isArray(catalog) ? catalog : []).filter((item) => {
    const row = record(item);
    return [row.name, row.slug].some((candidate) =>
      text(candidate, 160).toLowerCase().replace(/[^a-z0-9]+/g, "") === query
    );
  });
  return matches.length === 1 ? record(matches[0]) : null;
}

export function normalizeMonitorPlan(value, catalog) {
  const raw = record(value);
  const metric = [
    "current_vwc",
    "change_vwc",
    "sensor_stale",
    "controller_health",
  ].includes(raw.metric)
    ? raw.metric
    : "current_vwc";
  const comparator = [
    "above",
    "below",
    "increase_by",
    "decrease_by",
    "stale",
    "unhealthy",
  ].includes(raw.comparator)
    ? raw.comparator
    : "below";
  const requestedExperiment = text(raw.experiment, 160);
  const experiment = requestedExperiment
    ? exactExperiment(catalog, requestedExperiment)
    : null;
  const availablePairings = new Set(
    Array.isArray(experiment?.pairing_names) ? experiment.pairing_names : [],
  );
  const requestedPairings = Array.isArray(raw.pairing_names)
    ? raw.pairing_names.map((item) => text(item, 120)).filter(Boolean)
    : [];
  const questions = Array.isArray(raw.questions)
    ? raw.questions.map((item) => text(item, 180)).filter(Boolean)
    : [];
  const threshold = finiteNumber(raw.threshold);

  if (metric !== "controller_health" && !experiment) {
    questions.push("Choose one exact current experiment for this monitor.");
  }
  if (
    metric !== "controller_health" &&
    requestedPairings.some((pairing) => !availablePairings.has(pairing))
  ) {
    questions.push("Every monitored pot must belong to the selected experiment.");
  }
  if (
    ["current_vwc", "change_vwc"].includes(metric) &&
    (threshold === null || threshold < 0 || threshold > 100)
  ) {
    questions.push("Choose a threshold from 0% to 100%.");
  }
  const validComparator = {
    current_vwc: ["above", "below"],
    change_vwc: ["increase_by", "decrease_by"],
    sensor_stale: ["stale"],
    controller_health: ["unhealthy"],
  }[metric];
  if (!validComparator.includes(comparator)) {
    questions.push("The requested condition does not match the selected measurement.");
  }

  return {
    plan: {
      name: text(raw.name, 120) || "Experiment monitor",
      experiment_id: experiment?.id ?? null,
      experiment: experiment?.name ?? null,
      metric,
      comparator,
      threshold: ["current_vwc", "change_vwc"].includes(metric) ? threshold : null,
      window_minutes: Math.min(
        10_080,
        Math.max(5, finiteNumber(raw.window_minutes) ?? 60),
      ),
      pairing_names: metric === "controller_health"
        ? []
        : requestedPairings.length
        ? [...new Set(requestedPairings)]
        : [...availablePairings],
      check_every_minutes: Math.min(
        1_440,
        Math.max(5, finiteNumber(raw.check_every_minutes) ?? 10),
      ),
      cooldown_minutes: Math.min(
        10_080,
        Math.max(5, finiteNumber(raw.cooldown_minutes) ?? 60),
      ),
      questions: [...new Set(questions)].slice(0, 10),
    },
  };
}

export function monitorSystemInstructions() {
  return [
    "Convert the request into one ExactH2O monitoring rule.",
    "Use current_vwc with above or below for absolute moisture thresholds.",
    "Use change_vwc with increase_by or decrease_by for a change within a time window.",
    "Use sensor_stale with stale for missing readings.",
    "Use controller_health with unhealthy for controller, API, or connectivity problems.",
    "Use exact experiment and pairing names from the supplied catalog.",
    "For an experiment-wide rule, include every pairing in that experiment.",
    "If the experiment, threshold, or condition is ambiguous, ask one concise question.",
    "Monitoring creates portal alerts only. It never changes watering or controller configuration.",
    "Keep the rule name and questions concise.",
  ].join("\n");
}

/**
 * @param {unknown} currentPlan
 */
export function monitorUserInput(prompt, catalog, currentPlan = null) {
  const sections = [
    `Monitoring request:\n${text(prompt, 4_000)}`,
    `Current experiment catalog:\n${JSON.stringify(
      (Array.isArray(catalog) ? catalog : []).map((item) => {
        const row = record(item);
        return {
          id: row.id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          pairing_names: row.pairing_names,
        };
      }),
    )}`,
  ];
  if (currentPlan) {
    sections.push(`Current reviewed draft to revise:\n${JSON.stringify(currentPlan)}`);
  }
  return sections.join("\n\n");
}

export function automationReviewToken(kind, userId, projectId, plan, configHash = "") {
  return JSON.stringify({
    kind,
    user_id: text(userId, 80),
    project_id: text(projectId, 80),
    config_hash: text(configHash, 128),
    plan,
  });
}

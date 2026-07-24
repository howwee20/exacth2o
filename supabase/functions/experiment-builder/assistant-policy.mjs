export const assistantIntentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: ["experiment", "settings"],
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 160,
    },
  },
  required: ["intent", "reason"],
};

function text(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function normalizeAssistantIntent(value) {
  const route = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return {
    intent: route.intent === "settings" ? "settings" : "experiment",
    reason: text(route.reason, 160) || "Continue with the reviewed workflow.",
  };
}

export function assistantIntentInstructions() {
  return [
    "Route the researcher's ExactH2O request to one workflow.",
    "Choose experiment when they want to create, design, start, or define a new experiment, trial, calibration run, treatment, or set of experiment pots.",
    "Choose settings when they want to change an existing experiment or controller setting, pairing, group, calibration, hardware configuration, target, cadence, system state, or export.",
    "Choose settings for future-time watering, one-time watering, or scheduled controller requests; the settings workflow will enforce current safety limits.",
    "Do not invent capabilities or answer the request.",
    "Keep the reason concise and return only the required structured result.",
  ].join("\n");
}

export function assistantIntentInput(prompt) {
  return `Researcher request:\n${text(prompt, 4_000)}`;
}

export function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function clean(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

export async function sha256(value) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function openAiUsage(value) {
  const usage = record(value);
  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
  };
}

export function scheduleInputForNormalization(value) {
  const plan = record(value);
  const settingsPlan = record(plan.settings_plan);
  const commands = Array.isArray(settingsPlan.commands)
    ? settingsPlan.commands.map((item) => {
      const command = record(item);
      return {
        command_type: command.command_type,
        payload_json: typeof command.payload_json === "string"
          ? command.payload_json
          : JSON.stringify(record(command.payload)),
        effect: command.effect,
      };
    })
    : [];
  return {
    ...plan,
    settings_plan: {
      ...settingsPlan,
      commands,
    },
  };
}

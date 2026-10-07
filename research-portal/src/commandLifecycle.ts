/**
 * Plain-language progress for a portal request to the controller.
 *
 * requested -> queued -> accepted -> running -> executed, and separately
 * "physically verified". The portal can observe the first five from
 * project_control_commands. It has no flow, pressure or weight evidence, so it
 * never claims a watering command physically delivered water.
 */

export type CommandStatus =
  | "queued"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired";

export type CommandStage =
  | "requested"
  | "queued"
  | "accepted"
  | "running"
  | "executed"
  | "failed"
  | "canceled"
  | "expired";

export type CommandProgress = {
  stage: CommandStage;
  tone: "info" | "ok" | "warning" | "bad";
  title: string;
  detail: string;
  terminal: boolean;
  /** Always false: the portal has no physical delivery evidence. */
  physicallyVerified: false;
  /** Watering requests have a physical outcome (water delivered) that the portal cannot confirm. */
  hasPhysicalOutcome: boolean;
};

export type TrackedCommand = {
  ids: string[];
  label: string;
  commandType: string;
  requestedAt: string;
  statuses: Record<string, CommandStatus | undefined>;
};

const order: CommandStage[] = ["requested", "queued", "accepted", "running", "executed"];

export function stageForStatus(status: CommandStatus | null | undefined): CommandStage {
  if (!status) return "requested";
  if (status === "succeeded") return "executed";
  return status;
}

/** The least advanced stage across a batch; any failure wins. */
export function combinedStage(statuses: Array<CommandStatus | null | undefined>): CommandStage {
  if (!statuses.length) return "requested";
  const stages = statuses.map(stageForStatus);
  for (const terminal of ["failed", "expired", "canceled"] as const) {
    if (stages.includes(terminal)) return terminal;
  }
  return stages.reduce((least, stage) => (order.indexOf(stage) < order.indexOf(least) ? stage : least), "executed" as CommandStage);
}

function isWaterCommand(commandType: string) {
  return commandType === "manual_water";
}

export function describeCommandProgress(input: {
  label: string;
  commandType: string;
  stage: CommandStage;
  controllerOnline: boolean;
}): CommandProgress {
  const { label, commandType, stage, controllerOnline } = input;
  const water = isWaterCommand(commandType);
  const base = { physicallyVerified: false as const, hasPhysicalOutcome: water };
  switch (stage) {
    case "requested":
      return { ...base, stage, tone: "info", terminal: false, title: `${label}: request sent`, detail: "Waiting for the portal service to record the request." };
    case "queued":
      return {
        ...base,
        stage,
        tone: controllerOnline ? "info" : "warning",
        terminal: false,
        title: `${label}: queued`,
        detail: controllerOnline
          ? "Recorded and waiting for the controller to pick it up. Nothing has changed yet."
          : "Recorded, but the controller is offline. Nothing changes until it reconnects and accepts the request.",
      };
    case "accepted":
      return { ...base, stage, tone: "info", terminal: false, title: `${label}: accepted by controller`, detail: "The controller has accepted the request and has not finished it yet." };
    case "running":
      return { ...base, stage, tone: "info", terminal: false, title: `${label}: running`, detail: "The controller is carrying out the request." };
    case "executed":
      return {
        ...base,
        stage,
        tone: "ok",
        terminal: true,
        title: water ? `${label}: controller reported complete` : `${label}: confirmed by controller`,
        detail: water
          ? "The controller reported the valve pulse finished. Water delivery is not physically verified; the portal has no flow or weight evidence."
          : "The controller reported the change applied.",
      };
    case "failed":
      return { ...base, stage, tone: "bad", terminal: true, title: `${label}: failed`, detail: "The controller or service rejected the request. Nothing further will happen for it." };
    case "canceled":
      return { ...base, stage, tone: "warning", terminal: true, title: `${label}: canceled`, detail: "The request was canceled before it ran." };
    case "expired":
      return { ...base, stage, tone: "warning", terminal: true, title: `${label}: expired`, detail: "The controller did not pick the request up before it expired. Nothing changed." };
  }
}

export function trackedCommandProgress(command: TrackedCommand, controllerOnline: boolean) {
  const stage = combinedStage(command.ids.map((id) => command.statuses[id]));
  return describeCommandProgress({ label: command.label, commandType: command.commandType, stage, controllerOnline });
}

export function isCommandStatus(value: unknown): value is CommandStatus {
  return typeof value === "string" &&
    ["queued", "accepted", "running", "succeeded", "failed", "canceled", "expired"].includes(value);
}

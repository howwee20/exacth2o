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

export type CommandStepState = "done" | "current" | "pending" | "stopped";

export type CommandProgress = {
  stage: CommandStage;
  tone: "info" | "ok" | "warning" | "bad";
  title: string;
  detail: string;
  terminal: boolean;
  /** For a settings batch: each step in order (stop, change(s), restore). */
  steps?: Array<{ label: string; state: CommandStepState }>;
  /** Always false: the portal has no physical delivery evidence. */
  physicallyVerified: false;
  /** Watering requests have a physical outcome (water delivered) that the portal cannot confirm. */
  hasPhysicalOutcome: boolean;
};

export type TrackedCommand = {
  /** In execution order. For a settings batch: stop, change(s), restore. */
  ids: string[];
  label: string;
  commandType: string;
  requestedAt: string;
  statuses: Record<string, CommandStatus | undefined>;
  /** Settings batch only: a label per id, and the controller state the last step restores. */
  stepLabels?: string[];
  restoresTo?: string;
  /** The portal stopped polling before a final status arrived. */
  trackingStopped?: boolean;
};

export const settingsBatchCommandType = "settings_batch";

const order: CommandStage[] = ["requested", "queued", "accepted", "running", "executed"];

export function stageForStatus(status: CommandStatus | null | undefined): CommandStage {
  if (!status) return "requested";
  if (status === "succeeded") return "executed";
  return status;
}

/** The least advanced stage across a set of commands; any failure wins. Not used for settings batches. */
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

const unfinishedSuffix = " The portal stopped checking 15 minutes after the request without a final status, so this may be out of date. Check the controller state before relying on it.";

function isStoppedStatus(status: CommandStatus | undefined) {
  return status === "failed" || status === "expired" || status === "canceled";
}

/**
 * A reviewed settings change runs as a chain: stop the controller, apply each change, restore the
 * previous state. Each step waits for the one before; a failure cancels the rest of the chain. So the
 * meaningful questions are which step it has reached and, on failure, whether the controller was left
 * stopped. The least-advanced-step summary used for single requests would answer neither.
 */
export function describeSettingsBatch(input: {
  label: string;
  statuses: Array<CommandStatus | undefined>;
  stepLabels?: string[];
  restoresTo?: string;
  controllerOnline: boolean;
}): CommandProgress {
  const { label, statuses, controllerOnline } = input;
  const count = statuses.length;
  const base = { physicallyVerified: false as const, hasPhysicalOutcome: false };
  const stepLabel = (index: number) => input.stepLabels?.[index]
    ?? (index === 0 ? "Stop controller" : index === count - 1 ? "Restore previous state" : "Apply change");
  const current = statuses.findIndex((status) => status !== "succeeded");
  const steps = statuses.map((status, index) => ({
    label: stepLabel(index),
    state: (status === "succeeded"
      ? "done"
      : index === current
        ? (isStoppedStatus(status) ? "stopped" : "current")
        : current >= 0 && index > current && isStoppedStatus(statuses[current])
          ? "stopped"
          : "pending") as CommandStepState,
  }));
  const restoresRunning = input.restoresTo !== "stopped";

  if (current === -1) {
    return {
      ...base, steps, stage: "executed", tone: "ok", terminal: true,
      title: `${label}: confirmed by controller`,
      detail: restoresRunning
        ? "The controller stopped, applied the change and returned to its previous state."
        : "The controller applied the change and remains stopped, as it was before.",
    };
  }

  const status = statuses[current];
  const position = `step ${current + 1} of ${count}`;
  if (isStoppedStatus(status)) {
    const outcome = status === "failed" ? "failed" : status === "expired" ? "expired before the controller ran it" : "was canceled";
    if (current === 0) {
      return {
        ...base, steps, stage: status, tone: "warning", terminal: true,
        title: `${label}: not applied`,
        detail: `Stopping the controller ${outcome}, so the remaining steps were canceled. No settings changed.`,
      };
    }
    const stillStopped = restoresRunning
      ? "The controller is probably still stopped and not watering; check its state and start it again if needed."
      : "The controller was stopped beforehand and remains stopped.";
    const applied = current === count - 1
      ? "The change was applied, but restoring the previous state"
      : `${stepLabel(current)} (${position})`;
    return {
      ...base, steps, stage: status, tone: "bad", terminal: true,
      title: current === count - 1 ? `${label}: applied, not restored` : `${label}: stopped part-way`,
      detail: `${applied} ${outcome}.${current === count - 1 ? "" : " The remaining steps were canceled."} ${stillStopped}`,
    };
  }

  const waiting = !status || status === "queued";
  let detail: string;
  if (current === 0) {
    detail = waiting
      ? controllerOnline
        ? "Queued. Nothing has changed yet."
        : "Queued, but the controller is offline. Nothing changes until it reconnects."
      : "The controller is stopping before the change is applied.";
  } else if (current === count - 1) {
    detail = restoresRunning
      ? "The change is applied. The controller is stopped until this step returns it to its previous state."
      : "The change is applied. The controller stays stopped, as it was before.";
  } else {
    detail = "The controller has stopped and is applying the change. Watering is paused until the last step restores the previous state.";
  }
  return {
    ...base, steps, stage: stageForStatus(status), tone: !controllerOnline && waiting ? "warning" : "info", terminal: false,
    title: `${label}: ${stepLabel(current).toLowerCase()} (${position})`,
    detail,
  };
}

export function trackedCommandProgress(command: TrackedCommand, controllerOnline: boolean): CommandProgress {
  const statuses = command.ids.map((id) => command.statuses[id]);
  const progress = command.commandType === settingsBatchCommandType && command.ids.length >= 2
    ? describeSettingsBatch({ label: command.label, statuses, stepLabels: command.stepLabels, restoresTo: command.restoresTo, controllerOnline })
    : describeCommandProgress({ label: command.label, commandType: command.commandType, stage: combinedStage(statuses), controllerOnline });
  if (command.trackingStopped && !progress.terminal) {
    return { ...progress, tone: "warning", detail: progress.detail + unfinishedSuffix };
  }
  return progress;
}

export function isCommandStatus(value: unknown): value is CommandStatus {
  return typeof value === "string" &&
    ["queued", "accepted", "running", "succeeded", "failed", "canceled", "expired"].includes(value);
}

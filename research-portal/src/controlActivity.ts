export type ControlActivityStatus =
  | "queued"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired";

export type ControlActivityItem = {
  id: string;
  status: ControlActivityStatus;
  requested_at: string;
};

const activeStatuses = new Set<ControlActivityStatus>([
  "queued",
  "accepted",
  "running",
]);

export function isActiveControlStatus(status: ControlActivityStatus) {
  return activeStatuses.has(status);
}

export function activeControlCommandCount<T extends ControlActivityItem>(
  commands: readonly T[],
) {
  return commands.filter((command) => isActiveControlStatus(command.status)).length;
}

export function visibleControlCommands<T extends ControlActivityItem>(
  commands: readonly T[],
  limit = 4,
) {
  return commands
    .slice()
    .sort((left, right) => {
      const activeDifference =
        Number(isActiveControlStatus(right.status)) -
        Number(isActiveControlStatus(left.status));
      if (activeDifference) return activeDifference;
      return Date.parse(right.requested_at) - Date.parse(left.requested_at);
    })
    .slice(0, Math.max(0, limit));
}

export function controlActivityStatusLabel(status: ControlActivityStatus) {
  const labels: Record<ControlActivityStatus, string> = {
    queued: "Queued",
    accepted: "Accepted",
    running: "Running",
    succeeded: "Complete",
    failed: "Failed",
    canceled: "Canceled",
    expired: "Expired",
  };
  return labels[status];
}

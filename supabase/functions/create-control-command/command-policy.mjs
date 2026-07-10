export const researcherCommandTypes = new Set([
  "update_pairing",
  "bulk_update_pairings",
  "create_group",
  "create_calibration",
  "apply_calibration",
  "manual_water",
  "export_data",
]);

export const adminOnlyCommandTypes = new Set([
  "create_pairing",
  "remove_group",
  "delete_calibration",
  "update_board_config",
  "update_system_state",
]);

export const disabledCommandTypes = new Set([
  "initialize_sensors",
]);

export function controlCommandIntakeEnabled(value) {
  return value === "1";
}

/**
 * @param {unknown} role
 * @param {unknown} commandType
 * @returns {{ allowed: boolean, status: number, error: string | null }}
 */
export function commandAccessDecision(role, commandType) {
  if (disabledCommandTypes.has(String(commandType))) {
    return {
      allowed: false,
      status: 409,
      error: "Sensor initialization is locked until a backup, stopped-state, bench-test, and rollback protocol is approved.",
    };
  }

  if (role === "admin") {
    const allowed = researcherCommandTypes.has(String(commandType)) || adminOnlyCommandTypes.has(String(commandType));
    return {
      allowed,
      status: allowed ? 200 : 403,
      error: allowed ? null : "This command is not enabled for the portal.",
    };
  }

  if (role === "researcher" && researcherCommandTypes.has(String(commandType))) {
    return { allowed: true, status: 200, error: null };
  }

  return {
    allowed: false,
    status: 403,
    error: "Administrator access is required for this controller command.",
  };
}

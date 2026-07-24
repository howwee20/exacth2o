export type SettingsCommandType =
  | "update_pairing"
  | "bulk_update_pairings"
  | "create_pairing"
  | "delete_pairing"
  | "create_group"
  | "remove_group"
  | "create_calibration"
  | "delete_calibration"
  | "apply_calibration"
  | "update_board_config"
  | "update_system_state"
  | "export_data";

export type SettingsCommandDraft = {
  command_type: SettingsCommandType;
  payload: Record<string, unknown>;
  effect: string;
};

export type SettingsPlan = {
  summary: string;
  commands: SettingsCommandDraft[];
  questions: string[];
};

export type SettingsDraftResponse = {
  plan: SettingsPlan;
  inventory_updated_at: string;
  config_hash: string;
  model: string | null;
  prompt_fingerprint: string | null;
  validation_messages: string[];
};

export const stoppedSettingsCommandTypes = new Set<SettingsCommandType>([
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
]);

export function settingsCommandLabel(commandType: SettingsCommandType) {
  const labels: Record<SettingsCommandType, string> = {
    update_pairing: "Update pairing",
    bulk_update_pairings: "Update pairings",
    create_pairing: "Create pairing",
    delete_pairing: "Delete pairing",
    create_group: "Create group",
    remove_group: "Remove group",
    create_calibration: "Create calibration",
    delete_calibration: "Delete calibration",
    apply_calibration: "Apply calibration",
    update_board_config: "Update boards",
    update_system_state: "Change system state",
    export_data: "Export data",
  };
  return labels[commandType];
}

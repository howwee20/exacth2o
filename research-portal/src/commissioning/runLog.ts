import type { PotSettingsSnapshot, ValveChange } from "./topologyPlan";
import type { CommissioningResult } from "./types";

// Local record of REAL commissioning runs: the full audit log, the evidence, the
// topology that was in force beforehand (for rollback), and any change that was
// submitted. The authoritative record of every valve command also exists on the
// server in project_control_commands and the platform operation ledger; each
// command's intent text carries this run's ID so the two can be matched.

export const recordSchemaVersion = 1;
export const maxStoredRecords = 10;

export type MappingChangeRecord = {
  at: string;
  kind: "apply" | "rollback";
  changes: ValveChange[];
  submittedBy: string | null;
  readbackVerifiedAt: string | null;
};

export type CommissioningRecord = {
  schemaVersion: number;
  projectId: string;
  deviceId: string;
  experimentId: string;
  experimentName: string;
  operator: string | null;
  previousTopology: PotSettingsSnapshot[];
  result: CommissioningResult;
  mappingChanges: MappingChangeRecord[];
  physicalValidation: "pending";
};

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

const storageKey = (projectId: string) => `exacth2o.commissioning.v${recordSchemaVersion}.${projectId || "default"}`;

export function loadRecords(storage: KeyValueStorage | null, projectId: string): CommissioningRecord[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey(projectId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CommissioningRecord =>
      Boolean(item) && typeof item === "object"
      && (item as CommissioningRecord).schemaVersion === recordSchemaVersion
      && typeof (item as CommissioningRecord).result?.runId === "string");
  } catch {
    return [];
  }
}

export function saveRecord(storage: KeyValueStorage | null, record: CommissioningRecord) {
  if (!storage) return false;
  try {
    const others = loadRecords(storage, record.projectId).filter((item) => item.result.runId !== record.result.runId);
    storage.setItem(storageKey(record.projectId), JSON.stringify([record, ...others].slice(0, maxStoredRecords)));
    return true;
  } catch {
    return false;
  }
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function recordFileName(record: CommissioningRecord) {
  return `exacth2o-commissioning-${record.result.runId}.json`;
}

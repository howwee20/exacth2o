import type { AerialModel } from "../aerialLayout";
import type { PotBinding } from "../benchClient";
import type { PotSettingsSnapshot } from "../commissioning/topologyPlan";
import type { CommissioningResult } from "../commissioning/types";
import type { CommissioningSessionRow, CommissioningStore } from "../commissioningRecords";
import type { PortalRole } from "../portalAccess";
import type { SettingsPlan } from "../settingsSpec";
import type { PairingRow } from "../types";
import type { BatchKind, SessionRecord, SessionStatus, TrackedBatch } from "./sessionRecord";

export type SessionPatch = { status?: SessionStatus; active?: boolean; record?: SessionRecord };

/** What every step of an open session works with. */
export type WorkspaceContext = {
  projectId: string;
  deviceId: string;
  operator: string | null;
  role: PortalRole;
  store: CommissioningStore;
  /** Every pairing the controller reports (the whole installation). */
  pairings: readonly PairingRow[];
  byName: ReadonlyMap<string, PairingRow>;
  potForSensor: ReadonlyMap<string, number | null>;
  model: AerialModel;
  bindings: readonly PotBinding[];
  configHash: string | null;
  controllerState: string | null;
  controllerOnline: boolean;
  controlBusy: boolean;
  session: CommissioningSessionRow;
  record: SessionRecord;
  /** Each selected pot's settings before the session changed anything (server, immutable). */
  snapshot: PotSettingsSnapshot[];
  /** The run's evidence (run_result), loaded on demand. */
  result: CommissioningResult | null;
  resultLoading: boolean;
  resultError: string | null;
  loadResult: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Applies a change to the latest record and saves it; saves are serialized. */
  update: (change: (record: SessionRecord) => SessionPatch) => Promise<CommissioningSessionRow | null>;
  queuePlan: (kind: BatchKind, plan: SettingsPlan, extra?: Partial<TrackedBatch>, status?: SessionStatus) => Promise<TrackedBatch | null>;
  inspect: (pairingName: string) => void;
  showRestore: () => void;
  openOutput: (valveKey: string) => void;
};

/** "32:5" or "0x20:5" → relay board 32 (0x20), channel 5. Valve keys are the controller's identities. */
export function parseValveKey(valveKey: string): { relayAddress: number; channel: number } | null {
  const match = /^(0x[0-9a-f]{1,2}|\d{1,3}):(\d{1,2})$/i.exec(valveKey.trim());
  if (!match) return null;
  const relayAddress = /^0x/i.test(match[1]) ? parseInt(match[1], 16) : Number(match[1]);
  const channel = Number(match[2]);
  return relayAddress >= 3 && relayAddress <= 127 && channel >= 1 && channel <= 48 ? { relayAddress, channel } : null;
}

export function valveLabel(valveKey: string) {
  const parsed = parseValveKey(valveKey);
  return parsed ? `0x${parsed.relayAddress.toString(16)}:${parsed.channel}` : valveKey;
}

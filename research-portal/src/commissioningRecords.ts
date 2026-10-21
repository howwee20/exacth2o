import { pairingsFromDeviceConfigState } from "./portalData";
// Must stay "./supabase": the offline Applications demo swaps exactly that module.
import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";
import type { PairingRow } from "./types";
import type { CommissioningResult } from "./commissioning/types";
import { RunLeaseError } from "./autocalibrate/runLease";

// Durable records of autocalibration sessions. Kept apart from the hardware adapter
// (commissioningSupabasePorts.ts), which stays read-only apart from the command
// service. This module writes only public.commissioning_sessions (RLS: project
// researchers and administrators) and calls reconcile_autocalibration_bindings,
// which itself requires the controller's readback before it records anything. It
// never writes pairings, settings, or anything a controller acts on. The evidence
// matrix (run_result) is never part of a list or a routine refresh.

const timeoutMs = 20_000;

export { RunLeaseError };

export type CommissioningSessionRow = {
  id: string;
  run_id: string;
  status: string;
  active: boolean;
  pot_count: number;
  operator_label: string | null;
  created_by: string;
  original_snapshot: unknown;
  record: Record<string, unknown>;
  config_hash_at_start: string | null;
  heartbeat_at: string | null;
  run_token: string | null;
  stop_requested_at: string | null;
  stop_requested_by: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
};

const sessionColumns = "id,run_id,status,active,pot_count,operator_label,created_by,original_snapshot,record,config_hash_at_start,heartbeat_at,run_token,stop_requested_at,stop_requested_by,started_at,updated_at,ended_at";

/** Server-side records of autocalibration sessions: one active session per controller. */
export function createCommissioningStore(input: { projectId: string; deviceId: string }) {
  const { projectId, deviceId } = input;
  return {
    async active(): Promise<CommissioningSessionRow | null> {
      const result = await withSupabaseTimeout(
        supabase.from("commissioning_sessions").select(sessionColumns).eq("project_id", projectId).eq("device_id", deviceId).eq("active", true).maybeSingle(),
        timeoutMs, "Autocalibration session");
      if (result.error) throw new Error(result.error.message);
      return (result.data as CommissioningSessionRow | null) ?? null;
    },
    /** The run's evidence matrix, read only when a step needs it (it can be a few MB). */
    async loadResult(runId: string): Promise<CommissioningResult | null> {
      const result = await withSupabaseTimeout(
        supabase.from("commissioning_sessions").select("run_result").eq("project_id", projectId).eq("device_id", deviceId).eq("run_id", runId).maybeSingle(),
        60_000, "Autocalibration evidence");
      if (result.error) throw new Error(result.error.message);
      const value = (result.data as { run_result?: unknown } | null)?.run_result;
      return value && typeof value === "object" ? value as CommissioningResult : null;
    },
    async recent(limit = 8): Promise<CommissioningSessionRow[]> {
      const result = await withSupabaseTimeout(
        supabase.from("commissioning_sessions").select(sessionColumns).eq("project_id", projectId).eq("device_id", deviceId).order("started_at", { ascending: false }).limit(limit),
        timeoutMs, "Autocalibration history");
      if (result.error) throw new Error(result.error.message);
      return (result.data ?? []) as CommissioningSessionRow[];
    },
    /** Claims the controller. Fails if another session is active (unique index). */
    async create(row: { run_id: string; pot_count: number; operator_label: string | null; original_snapshot: unknown; record: Record<string, unknown>; config_hash_at_start: string | null; status: string }) {
      const result = await withSupabaseTimeout(
        supabase.from("commissioning_sessions").insert({ project_id: projectId, device_id: deviceId, ...row }).select(sessionColumns).single(),
        timeoutMs, "Start autocalibration session");
      if (result.error) {
        if (/duplicate key|commissioning_sessions_one_active/i.test(result.error.message)) {
          throw new Error("Another autocalibration session is already open on this controller.");
        }
        throw new Error(result.error.message);
      }
      return result.data as CommissioningSessionRow;
    },
    async update(runId: string, patch: { status?: string; active?: boolean; record?: Record<string, unknown>; run_result?: Record<string, unknown> | null; operator_label?: string | null; heartbeat_at?: string | null }) {
      const result = await withSupabaseTimeout(
        supabase.from("commissioning_sessions").update(patch).eq("project_id", projectId).eq("device_id", deviceId).eq("run_id", runId).select(sessionColumns).single(),
        timeoutMs, "Save autocalibration session");
      if (result.error) throw new Error(result.error.message);
      return result.data as CommissioningSessionRow;
    },
    /**
     * Takes the session for this screen's run segment. Refused while another screen's
     * heartbeat is fresh by the database clock.
     */
    async claimRun(runId: string, token: string) {
      const result = await withSupabaseTimeout(
        supabase.rpc("claim_commissioning_run", { claim_project_id: projectId, claim_device_id: deviceId, claim_run_id: runId, claim_token: token }),
        timeoutMs, "Claim autocalibration run");
      if (result.error) throw new Error(result.error.message);
      return result.data as CommissioningSessionRow;
    },
    /** Renews this screen's hold on the run; throws once another screen holds it. */
    async renewRun(runId: string, token: string) {
      const result = await withSupabaseTimeout(
        supabase.rpc("renew_commissioning_run", { renew_project_id: projectId, renew_device_id: deviceId, renew_run_id: runId, renew_token: token }),
        timeoutMs, "Autocalibration heartbeat");
      if (result.error) throw new RunLeaseError(result.error.message, /no longer holds/i.test(result.error.message));
      return result.data as { stop_requested_at: string | null; stop_requested_by: string | null; heartbeat_at: string | null };
    },
    /** Saves the running segment's record, only while this screen still holds the run. */
    async saveRun(runId: string, token: string, patch: { status?: string; record?: Record<string, unknown>; run_result?: Record<string, unknown> | null; heartbeat_at?: string | null; run_token?: string | null }) {
      const result = await withSupabaseTimeout(
        supabase.from("commissioning_sessions").update(patch).eq("project_id", projectId).eq("device_id", deviceId).eq("run_id", runId).eq("run_token", token).select(sessionColumns).maybeSingle(),
        patch.run_result ? 60_000 : timeoutMs, "Save autocalibration run");
      if (result.error) throw new Error(result.error.message);
      return (result.data as CommissioningSessionRow | null) ?? null;
    },
    /** Asks the screen running this session to stop before its next pulse. */
    async requestStop(runId: string) {
      const result = await withSupabaseTimeout(
        supabase.from("commissioning_sessions").update({ stop_requested_at: new Date().toISOString() }).eq("project_id", projectId).eq("device_id", deviceId).eq("run_id", runId).select(sessionColumns).single(),
        timeoutMs, "Request autocalibration stop");
      if (result.error) throw new Error(result.error.message);
      return result.data as CommissioningSessionRow;
    },
    async clearStopRequest(runId: string) {
      const result = await withSupabaseTimeout(
        supabase.from("commissioning_sessions").update({ stop_requested_at: null }).eq("project_id", projectId).eq("device_id", deviceId).eq("run_id", runId).select(sessionColumns).single(),
        timeoutMs, "Clear autocalibration stop request");
      if (result.error) throw new Error(result.error.message);
      return result.data as CommissioningSessionRow;
    },
    async reconcileBindings(runId: string, changes: Array<{ pairing_name: string; sensor_key: string; valve_key: string; evidence?: Record<string, unknown> }>) {
      const result = await withSupabaseTimeout(
        supabase.rpc("reconcile_autocalibration_bindings", { reconcile_project_id: projectId, reconcile_device_id: deviceId, reconcile_run_id: runId, changes }),
        timeoutMs, "Binding reconciliation");
      if (result.error) throw new Error(result.error.message);
      return result.data as { reconciled: number; skipped: Array<{ pairing_name: string; reason: string }>; config_hash: string | null };
    },
    /** Records that an operator watched water reach these pots at the bench. */
    async confirmDelivery(runId: string, pairingNames: string[], note: string) {
      const result = await withSupabaseTimeout(
        supabase.rpc("confirm_autocalibration_delivery", { confirm_project_id: projectId, confirm_device_id: deviceId, confirm_run_id: runId, pairing_names: pairingNames, note }),
        timeoutMs, "Bench confirmation");
      if (result.error) throw new Error(result.error.message);
      return result.data as { confirmed: number; skipped: Array<{ pairing_name: string; reason: string }> };
    },
    /** Status of the commands in a queued settings batch. */
    async commandStatuses(ids: readonly string[]) {
      if (!ids.length) return [];
      const result = await withSupabaseTimeout(
        supabase.from("project_control_commands").select("id,status,error,result,command_type,completed_at").eq("project_id", projectId).in("id", ids as string[]),
        timeoutMs, "Settings batch status");
      if (result.error) throw new Error(result.error.message);
      return (result.data ?? []) as CommandStatusRow[];
    },
    /** The controller's configuration as last read back from the controller. */
    async readback(): Promise<{ pairings: PairingRow[]; configHash: string | null; observedAt: string | null }> {
      const result = await withSupabaseTimeout(
        supabase.from("device_config_state").select("pairings,groups,config_hash,observed_at").eq("project_id", projectId).eq("device_id", deviceId).maybeSingle(),
        timeoutMs, "Controller readback");
      if (result.error) throw new Error(result.error.message);
      const row = result.data as { pairings?: unknown; groups?: unknown; config_hash?: string | null; observed_at?: string | null } | null;
      return { pairings: pairingsFromDeviceConfigState(row?.pairings, row?.groups), configHash: row?.config_hash ?? null, observedAt: row?.observed_at ?? null };
    },
  };
}

export type CommandStatusRow = { id: string; status: string; error: string | null; result: Record<string, unknown> | null; command_type: string; completed_at: string | null };

export type CommissioningStore = ReturnType<typeof createCommissioningStore>;

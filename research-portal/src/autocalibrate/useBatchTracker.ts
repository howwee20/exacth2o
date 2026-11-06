import { useCallback, useEffect, useRef } from "react";
import type { CommandStatusRow, CommissioningStore } from "../commissioningRecords";
import type { PairingRow } from "../types";
import type { TrackedBatch } from "./sessionRecord";

const failedStates = new Set(["failed", "canceled", "expired"]);

const stepNames: Record<string, string> = {
  update_system_state: "Stop or restart the controller",
  bulk_update_pairings: "Prepare the pots",
  remap_pairing_valves: "Move pots to their measured valves",
  restore_pairing_settings: "Restore the recorded settings",
};

/** The queue's view of a batch: every command succeeded, one failed, or still going. */
export function commandsState(ids: readonly string[], rows: readonly CommandStatusRow[]): Pick<TrackedBatch, "commands" | "error"> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const failed = ids.map((id) => byId.get(id)).find((row) => row && failedStates.has(row.status));
  if (failed) return { commands: "failed", error: `${stepNames[failed.command_type] ?? failed.command_type}: ${failed.error ?? failed.status}` };
  if (ids.length && ids.every((id) => byId.get(id)?.status === "succeeded")) return { commands: "succeeded", error: null };
  return { commands: "queued", error: null };
}

export function batchSettled(batch: TrackedBatch) {
  return batch.readback === "verified" || (batch.commands === "failed" && batch.readback !== "pending");
}

/**
 * Follows one queued settings batch to its end: first the command queue, then the
 * controller's own configuration read back. The readback decides: a batch whose last
 * step failed can still have applied its change, and a change is only "in force" once
 * the controller reports it.
 */
export function useBatchTracker(input: {
  store: Pick<CommissioningStore, "commandStatuses" | "readback">;
  batch: TrackedBatch | null;
  evaluate: (pairings: PairingRow[]) => TrackedBatch["readback"];
  onChange: (batch: TrackedBatch) => void;
  intervalMs?: number;
  /** Stop polling a batch that has not settled after this long; "Check again" resumes. */
  timeoutMs?: number;
}) {
  const { store, batch, intervalMs = 4000, timeoutMs = 8 * 60_000 } = input;
  const latest = useRef(input);
  latest.current = input;
  const failedReadbacks = useRef(0);
  const busy = useRef(false);

  const tick = useCallback(async () => {
    const current = latest.current.batch;
    if (!current || busy.current) return;
    busy.current = true;
    try {
      let next: TrackedBatch = current;
      if (current.commands === "queued" || current.commands === "unknown") {
        const rows = await store.commandStatuses(current.commandIds);
        next = { ...next, ...commandsState(current.commandIds, rows) };
      }
      if (next.commands !== "queued") {
        const readback = await store.readback();
        const state = latest.current.evaluate(readback.pairings);
        if (state === "verified") next = { ...next, readback: "verified", verifiedAt: next.verifiedAt ?? new Date().toISOString() };
        else if (next.commands === "failed") {
          // Give the controller's readback a few polls to arrive before calling it.
          failedReadbacks.current += 1;
          if (failedReadbacks.current >= 3) next = { ...next, readback: state === "pending" ? "not_applied" : state };
        } else if (state === "mismatch") next = { ...next, readback: "mismatch" };
      }
      if (JSON.stringify(next) !== JSON.stringify(current)) latest.current.onChange(next);
    } catch {
      // A failed poll is retried on the next tick.
    } finally {
      busy.current = false;
    }
  }, [store]);

  const key = batch ? `${batch.kind}:${batch.batchId}:${batch.queuedAt}` : null;
  const settled = batch ? batchSettled(batch) : true;
  const expired = batch ? Date.now() - Date.parse(batch.queuedAt) > timeoutMs : true;

  useEffect(() => {
    failedReadbacks.current = 0;
  }, [key]);

  useEffect(() => {
    if (!key || settled || expired) return undefined;
    void tick();
    const timer = window.setInterval(() => void tick(), intervalMs);
    return () => window.clearInterval(timer);
  }, [key, settled, expired, intervalMs, tick]);

  return { recheck: tick, expired: !settled && expired };
}

import { supabase } from "./supabase";
import { supabaseQueryTimeoutMs } from "./portalConstants";
import { withSupabaseTimeout } from "./supabaseTimeout";
import type { ValveEvent } from "./types";

/**
 * Read the same experiment window as its sensor traces, without the live cache's seven-day limit.
 * With `receivedSince`, only events stored at or after that server time (an incremental refresh).
 */
export async function loadExperimentValveEvents(input: { projectId: string; deviceId: string; pairingNames: readonly string[]; startMs: number | null; endMs: number; receivedSince?: string; signal: AbortSignal }) {
  const events: ValveEvent[] = [];
  if (!input.pairingNames.length) return events;
  const orderColumn = input.receivedSince ? "server_received_at" : "device_recorded_at";
  let before: { at: string; id: number } | null = null;
  while (true) {
    input.signal.throwIfAborted();
    let query = supabase.from("valve_events").select("*").eq("project_id", input.projectId).eq("device_id", input.deviceId)
      .in("pairing_name", [...input.pairingNames]).lte("device_recorded_at", new Date(input.endMs).toISOString())
      .order(orderColumn, { ascending: false }).order("id", { ascending: false }).limit(1000);
    if (input.startMs !== null) query = query.gte("device_recorded_at", new Date(input.startMs).toISOString());
    if (input.receivedSince) query = query.gte("server_received_at", input.receivedSince);
    if (before) query = query.or(`${orderColumn}.lt.${before.at},and(${orderColumn}.eq.${before.at},id.lt.${before.id})`);
    const result = await withSupabaseTimeout(query, supabaseQueryTimeoutMs, "Experiment watering events", input.signal);
    if (result.error) throw result.error;
    input.signal.throwIfAborted();
    const rows = (result.data ?? []) as ValveEvent[];
    events.push(...rows);
    if (rows.length < 1000) return events;
    const last = rows.at(-1)!;
    if (before && String(before.at) === last[orderColumn] && Number(before.id) === last.id) throw new Error("Watering pagination did not advance.");
    before = { at: last[orderColumn], id: last.id };
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

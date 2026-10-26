import { supabase } from "./supabase";
import { supabaseQueryTimeoutMs } from "./portalConstants";
import { withSupabaseTimeout } from "./supabaseTimeout";
import type { ValveEvent } from "./types";

/** Read the same experiment window as its sensor traces, without the live cache's seven-day limit. */
export async function loadExperimentValveEvents(input: { projectId: string; deviceId: string; pairingNames: readonly string[]; startMs: number | null; endMs: number; signal: AbortSignal }) {
  const events: ValveEvent[] = [];
  if (!input.pairingNames.length) return events;
  let before: { at: string; id: number } | null = null;
  while (true) {
    input.signal.throwIfAborted();
    let query = supabase.from("valve_events").select("*").eq("project_id", input.projectId).eq("device_id", input.deviceId)
      .in("pairing_name", [...input.pairingNames]).lte("device_recorded_at", new Date(input.endMs).toISOString())
      .order("device_recorded_at", { ascending: false }).order("id", { ascending: false }).limit(1000);
    if (input.startMs !== null) query = query.gte("device_recorded_at", new Date(input.startMs).toISOString());
    if (before) query = query.or(`device_recorded_at.lt.${before.at},and(device_recorded_at.eq.${before.at},id.lt.${before.id})`);
    const result = await withSupabaseTimeout(query, supabaseQueryTimeoutMs, "Experiment watering events");
    if (result.error) throw result.error;
    input.signal.throwIfAborted();
    const rows = (result.data ?? []) as ValveEvent[];
    events.push(...rows);
    if (rows.length < 1000) return events;
    const last = rows.at(-1)!;
    if (before && String(before.at) === last.device_recorded_at && Number(before.id) === last.id) throw new Error("Watering pagination did not advance.");
    before = { at: last.device_recorded_at, id: last.id };
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

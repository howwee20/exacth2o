import { supabase } from "./supabase";
import type { BenchLayoutDocument } from "./benchLayout";

/** Physical identity of a pot: the research pot record and its current hardware binding. */
export type PotBinding = {
  researchPotId: string;
  potNumber: number;
  label: string;
  positionLabel: string | null;
  pairingName: string;
  sensorKey: string | null;
  valveKey: string | null;
  physicalStatus: "software_only" | "researcher_confirmed" | "delivery_verified" | "retired" | string;
  effectiveAt: string | null;
};

type BindingRow = {
  pot_id: string;
  pairing_name: string;
  sensor_key: string | null;
  valve_key: string | null;
  physical_status: string;
  effective_at: string | null;
};
type PotRow = { id: string; pot_number: number; label: string; position_id: string | null };
type PositionRow = { id: string; position_label: string };

/** Active bindings (retired_at is null) for one controller, joined to their research pots. */
export async function loadPotBindings(projectId: string, deviceId: string): Promise<PotBinding[]> {
  const [bindings, pots, positions] = await Promise.all([
    supabase
      .from("hardware_bindings")
      .select("pot_id,pairing_name,sensor_key,valve_key,physical_status,effective_at")
      .eq("project_id", projectId)
      .eq("device_id", deviceId)
      .is("retired_at", null)
      .limit(2000),
    supabase.from("research_pots").select("id,pot_number,label,position_id").eq("project_id", projectId).eq("active", true).limit(2000),
    supabase.from("physical_positions").select("id,position_label").eq("project_id", projectId).limit(2000),
  ]);
  for (const result of [bindings, pots, positions]) if (result.error) throw result.error;
  const potById = new Map(((pots.data ?? []) as PotRow[]).map((pot) => [pot.id, pot]));
  const positionById = new Map(((positions.data ?? []) as PositionRow[]).map((position) => [position.id, position.position_label]));
  return ((bindings.data ?? []) as BindingRow[]).flatMap((binding) => {
    const pot = potById.get(binding.pot_id);
    if (!pot) return [];
    return [{
      researchPotId: pot.id,
      potNumber: pot.pot_number,
      label: pot.label,
      positionLabel: pot.position_id ? positionById.get(pot.position_id) ?? null : null,
      pairingName: binding.pairing_name,
      sensorKey: binding.sensor_key,
      valveKey: binding.valve_key,
      physicalStatus: binding.physical_status,
      effectiveAt: binding.effective_at,
    }];
  });
}

export type BenchLayoutVersion = {
  id: string;
  version: number;
  layout: BenchLayoutDocument;
  basis: "recorded";
  note: string | null;
  author_label: string;
  created_at: string;
};

/** The newest recorded layout for a controller, and how many versions exist. */
export async function loadLatestBenchLayout(projectId: string, deviceId: string): Promise<{ latest: BenchLayoutVersion | null; versions: number }> {
  const { data, error, count } = await supabase
    .from("portal_bench_layout_versions")
    .select("id,version,layout,basis,note,author_label,created_at", { count: "exact" })
    .eq("project_id", projectId)
    .eq("device_id", deviceId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw error;
  return { latest: (data?.[0] as BenchLayoutVersion | undefined) ?? null, versions: count ?? (data?.length ?? 0) };
}

/** Record a new layout version (administrators). The database assigns the version number. */
export async function recordBenchLayout(projectId: string, deviceId: string, layout: BenchLayoutDocument, note: string | null, authorLabel: string) {
  const { data, error } = await supabase
    .from("portal_bench_layout_versions")
    .insert({ project_id: projectId, device_id: deviceId, version: 1, layout, basis: "recorded", note, author_label: authorLabel })
    .select("id,version,layout,basis,note,author_label,created_at")
    .single();
  if (error) throw error;
  return data as BenchLayoutVersion;
}

import { supabase } from "./supabase";
import { walkerDeviceId, walkerProjectId } from "./walkerObservation";
import type { WalkerPortalExperiment } from "./walkerExperiments";

export type WalkerSensorOption = { source_sensor_id: number; display_label: string; position_number: number | null };
const columns = "id,project_id,device_id,name,sensor_ids,started_at,created_at";

export async function loadWalkerExperiments() {
  const { data, error } = await supabase.from("walker_portal_experiments").select(columns)
    .eq("project_id", walkerProjectId).eq("device_id", walkerDeviceId).order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as WalkerPortalExperiment[];
}

export async function loadWalkerExperiment(id: string) {
  const { data, error } = await supabase.from("walker_portal_experiments").select(columns)
    .eq("project_id", walkerProjectId).eq("device_id", walkerDeviceId).eq("id", id).single();
  if (error) throw error;
  return data as WalkerPortalExperiment;
}

export async function loadWalkerSensorOptions() {
  const { data, error } = await supabase.from("walker_observation_sensor_metadata")
    .select("source_sensor_id,display_label,position_number")
    .eq("project_id", walkerProjectId).eq("device_id", walkerDeviceId).order("position_number");
  if (error) throw error;
  return (data ?? []) as WalkerSensorOption[];
}

export async function createWalkerExperiment(name: string, sensorIds: number[], requestId: string) {
  const { data, error } = await supabase.rpc("create_walker_portal_experiment", {
    requested_name: name, requested_sensor_ids: sensorIds, request_id: requestId,
  });
  if (error) throw error;
  return data as WalkerPortalExperiment;
}

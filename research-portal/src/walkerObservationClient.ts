import { supabase } from "./supabase";
import {
  walkerDefaultPointBudget,
  walkerDefaultWindowHours,
  walkerDeviceId,
  walkerProjectId,
  type WalkerLiveSnapshot,
  type WalkerLiveStatus,
} from "./walkerObservation";

export async function loadWalkerLiveStatus(): Promise<WalkerLiveStatus> {
  const { data, error } = await supabase.rpc("walker_live_observation_status", {
    requested_project_id: walkerProjectId,
    requested_device_id: walkerDeviceId,
  });
  if (error) throw error;
  return data as WalkerLiveStatus;
}

export async function loadWalkerLiveSnapshot(lastRecorded = false): Promise<WalkerLiveSnapshot> {
  const { data, error } = await supabase.rpc(lastRecorded ? "walker_latest_recorded_snapshot" : "walker_live_observation_snapshot", {
    requested_project_id: walkerProjectId,
    requested_device_id: walkerDeviceId,
    requested_window_hours: walkerDefaultWindowHours,
    requested_point_budget: walkerDefaultPointBudget,
  });
  if (error) throw error;
  return data as WalkerLiveSnapshot;
}

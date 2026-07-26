import { supabase } from "./supabase";
import {
  walkerDeviceId,
  walkerProjectId,
  type WalkerOverview,
  type WalkerTracePage,
} from "./walkerObservation";

export async function loadWalkerOverview(): Promise<WalkerOverview> {
  const { data, error } = await supabase.rpc("walker_observation_overview", {
    requested_project_id: walkerProjectId,
    requested_device_id: walkerDeviceId,
  });
  if (error) throw error;
  return data as WalkerOverview;
}

export async function loadWalkerTraces(
  sensorIds: number[],
  pointBudget = 240,
): Promise<WalkerTracePage> {
  const { data, error } = await supabase.rpc("walker_observation_trace_page", {
    requested_project_id: walkerProjectId,
    requested_device_id: walkerDeviceId,
    requested_sensor_ids: sensorIds,
    requested_start: null,
    requested_end: null,
    requested_point_budget: pointBudget,
  });
  if (error) throw error;
  return data as WalkerTracePage;
}

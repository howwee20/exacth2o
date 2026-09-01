import { supabase } from "./supabase";
import {
  lightingDeviceId,
  lightingProjectId,
  type LightingNativeStatus,
} from "./lightingNative";

export async function loadLightingNativeStatus(): Promise<LightingNativeStatus> {
  const { data, error } = await supabase.rpc("lighting_native_status", {
    requested_project_id: lightingProjectId,
    requested_device_id: lightingDeviceId,
  });
  if (error) throw error;
  return data as LightingNativeStatus;
}

export async function sendLightingIntensity(intensity: number, expectedRevision: number) {
  const { data, error } = await supabase.functions.invoke("lighting-native-control", {
    body: {
      action: "set_intensity",
      intensity,
      expected_revision: expectedRevision,
      idempotency_key: crypto.randomUUID(),
    },
  });
  if (error) {
    const context = error.context as Response | undefined;
    if (context) {
      try {
        const body = await context.clone().json() as { error?: string };
        if (body.error) throw new Error(body.error);
      } catch (reason) {
        if (reason instanceof Error && reason.message !== "Unexpected end of JSON input") throw reason;
      }
    }
    throw new Error(error.message || "Unable to send the lighting value");
  }
  return data as {
    ok: true;
    command: { id: string; status: string; intensity: number };
  };
}

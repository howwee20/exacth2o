import { supabase } from "./supabase";
import {
  gasMixerDeviceId,
  gasMixerProjectId,
  type GasMixerSessionAccess,
  type GasMixerSessionMode,
  type GasMixerRemoteStatus,
} from "./chamberControl";

export async function loadGasMixerRemoteStatus(): Promise<GasMixerRemoteStatus> {
  const { data, error } = await supabase.rpc("gas_mixer_remote_status", {
    requested_project_id: gasMixerProjectId,
    requested_device_id: gasMixerDeviceId,
  });
  if (error) throw error;
  return data as GasMixerRemoteStatus;
}

export async function createGasMixerSession(mode: GasMixerSessionMode): Promise<GasMixerSessionAccess> {
  const { data, error } = await supabase.functions.invoke<GasMixerSessionAccess>("gas-mixer-session", {
    body: { action: "create_session", mode },
  });
  if (error) throw error;
  if (!data?.session_token || !data.frame_url || !data.session) {
    throw new Error("The Gas Mixer session response was incomplete");
  }
  return data;
}

export async function sendGasMixerTap(
  sessionToken: string,
  normalizedX: number,
  normalizedY: number,
) {
  const { data, error } = await supabase.functions.invoke("gas-mixer-session", {
    body: {
      action: "send_input",
      session_token: sessionToken,
      event_type: "tap",
      normalized_x: normalizedX,
      normalized_y: normalizedY,
    },
  });
  if (error) throw error;
  return data;
}

export async function endGasMixerSession(sessionToken: string) {
  const { error } = await supabase.functions.invoke("gas-mixer-session", {
    body: { action: "end_session", session_token: sessionToken },
  });
  if (error) throw error;
}

import { supabase } from "./supabase";
import { gasMixerDeviceId, gasMixerProjectId } from "./chamberControl";
import { gasMixerFunctionError } from "./gasMixerErrors";
import type {
  GasMixerNativeField,
  GasMixerNativeStatus,
} from "./gasMixerNative";

export async function loadGasMixerNativeStatus(): Promise<GasMixerNativeStatus> {
  const { data, error } = await supabase.rpc("gas_mixer_native_status", {
    requested_project_id: gasMixerProjectId,
    requested_device_id: gasMixerDeviceId,
  });
  if (error) throw error;
  return data as GasMixerNativeStatus;
}

export async function sendGasMixerNativeField(
  field: GasMixerNativeField,
  value: number | boolean,
  expectedRevision: number,
) {
  const { data, error } = await supabase.functions.invoke("gas-mixer-native-control", {
    body: {
      action: "set_field",
      field,
      value,
      expected_revision: expectedRevision,
      idempotency_key: crypto.randomUUID(),
    },
  });
  if (error) throw await gasMixerFunctionError(error, "Unable to send the mixer value");
  return data as {
    ok: true;
    command: { id: string; status: string };
    requested_state: GasMixerNativeStatus["requested_state"];
  };
}

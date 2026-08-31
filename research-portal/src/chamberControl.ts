export const gasMixerProjectId = "44444444-4444-4444-8444-444444444441";
export const gasMixerDeviceId = "gas-mixer:b827eb548a44";

export type GasMixerRemoteStatus = {
  project_id: string;
  device_id: string;
  device_name: string;
  online: boolean;
  last_seen_at: string | null;
  remote_control_allowed: boolean;
  active_session: boolean;
  active_controller_email: string | null;
};

export type GasMixerSessionMode = "view" | "control";

export type GasMixerRemoteSession = {
  id: string;
  mode: GasMixerSessionMode;
  issued_at: string;
  expires_at: string;
};

export type GasMixerSessionAccess = {
  session: GasMixerRemoteSession;
  frame_url: string;
  session_token: string;
};

const mixerSessionRenewalLeadMs = 60_000;

export function gasMixerSessionRenewalDelay(
  expiresAt: string,
  nowMs = Date.now(),
) {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return 1_000;
  return Math.max(1_000, expiresAtMs - nowMs - mixerSessionRenewalLeadMs);
}

export function normalizedMixerPoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
) {
  if (bounds.width <= 0 || bounds.height <= 0) throw new Error("Mixer frame is not measurable");
  return {
    x: Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height)),
  };
}

export function gasMixerAccessDenied(error: { code?: string; message?: string }) {
  return error.code === "42501" || /installation access is required/i.test(error.message ?? "");
}

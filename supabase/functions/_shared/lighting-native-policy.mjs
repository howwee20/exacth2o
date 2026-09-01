export const LIGHTING_MIN_INTENSITY = 10;
export const LIGHTING_MAX_INTENSITY = 255;
export const LIGHTING_CONTROLLER_MAX_INTENSITY = 2090;

export function normalizeLightingIntensity(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric)) throw new Error("Intensity must be a whole number");
  if (numeric !== 0 && (numeric < LIGHTING_MIN_INTENSITY || numeric > LIGHTING_MAX_INTENSITY)) {
    throw new Error(`Enter 0 (off) or ${LIGHTING_MIN_INTENSITY}-${LIGHTING_MAX_INTENSITY}`);
  }
  return numeric;
}

export function normalizeLightingControllerIntensity(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new Error("Controller intensity must be numeric");
  if (numeric !== 0 && (numeric < LIGHTING_MIN_INTENSITY || numeric > LIGHTING_CONTROLLER_MAX_INTENSITY)) {
    throw new Error(`Controller intensity is outside 0 or ${LIGHTING_MIN_INTENSITY}-${LIGHTING_CONTROLLER_MAX_INTENSITY}`);
  }
  return Math.round(numeric * 1_000) / 1_000;
}

export function lightingBridgeIsReady(state, now = Date.now()) {
  if (!state?.bridge_connected || !state?.bridge_ready || !state?.last_bridge_at) return false;
  const lastBridgeAt = Date.parse(state.last_bridge_at);
  return Number.isFinite(lastBridgeAt) && now - lastBridgeAt <= 15_000;
}

export function nextLightingState(current, controllerIntensity, source) {
  const intensity = normalizeLightingControllerIntensity(controllerIntensity);
  return {
    controller_intensity: intensity,
    requested_intensity: intensity,
    last_nonzero_intensity: intensity === 0
      ? current.last_nonzero_intensity
      : intensity,
    last_source: source,
    state_revision: Number(current.state_revision ?? 0) + 1,
  };
}

import { describe, expect, it } from "vitest";
import {
  gasMixerAccessDenied,
  gasMixerStatusLabel,
  normalizedMixerPoint,
  type GasMixerRemoteStatus,
} from "./chamberControl";

const status = (overrides: Partial<GasMixerRemoteStatus> = {}): GasMixerRemoteStatus => ({
  project_id: "project",
  device_id: "device",
  device_name: "Gas Mixer",
  online: false,
  last_seen_at: null,
  remote_control_allowed: false,
  active_session: false,
  active_controller_email: null,
  ...overrides,
});

describe("gas mixer portal presentation", () => {
  it("keeps an unconnected device honest", () => {
    expect(gasMixerStatusLabel(status())).toBe("Waiting for the Pi agent");
  });

  it("distinguishes ready and active sessions", () => {
    expect(gasMixerStatusLabel(status({ online: true }))).toBe("Ready for secure viewing");
    expect(gasMixerStatusLabel(status({ online: true, active_session: true }))).toBe("Remote session active");
  });

  it("fails closed when installation access is denied", () => {
    expect(gasMixerAccessDenied({ code: "42501" })).toBe(true);
    expect(gasMixerAccessDenied({ message: "System-admin installation access is required" })).toBe(true);
    expect(gasMixerAccessDenied({ message: "network error" })).toBe(false);
  });

  it("maps portal taps to normalized mixer coordinates", () => {
    expect(normalizedMixerPoint(150, 75, { left: 50, top: 25, width: 200, height: 100 }))
      .toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedMixerPoint(-10, 500, { left: 0, top: 0, width: 100, height: 100 }))
      .toEqual({ x: 0, y: 1 });
  });
});

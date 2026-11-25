import { describe, expect, it } from "vitest";
import { freshControllerState } from "./portalFormat";
import type { DeviceRuntimeState } from "./portalTypes";

const now = Date.parse("2026-11-25T12:00:00Z");
const state = (controller_state: string | null, fresh = "2026-11-25T12:05:00Z") =>
  ({ device_id: "dev-1", controller_state, state_fresh_until: fresh }) as unknown as DeviceRuntimeState;

describe("freshControllerState", () => {
  it("accepts the controller's published RUNNING / STOPPED spelling", () => {
    // The database only allows RUNNING / STOPPED; the soil-curve assignment stayed disabled when this was compared case-sensitively.
    expect(freshControllerState(state("RUNNING"), "dev-1", now)).toBe("running");
    expect(freshControllerState(state(" STOPPED "), "dev-1", now)).toBe("stopped");
  });
  it("is unknown when stale, for another controller, or unrecognised", () => {
    expect(freshControllerState(state("RUNNING", "2026-11-25T11:59:00Z"), "dev-1", now)).toBeNull();
    expect(freshControllerState(state("RUNNING"), "dev-2", now)).toBeNull();
    expect(freshControllerState(state("PAUSED"), "dev-1", now)).toBeNull();
    expect(freshControllerState(null, "dev-1", now)).toBeNull();
  });
});

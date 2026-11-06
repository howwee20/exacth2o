import { afterEach, describe, expect, it, vi } from "vitest";
import { controllerOwnership } from "./controllerOwnership";

describe("shared controller ownership in this tab", () => {
  afterEach(() => controllerOwnership.stopAll());

  it("manual troubleshooting interrupts this tab's autocalibration run before the hold starts", () => {
    const interruptForManual = vi.fn();
    const release = controllerOwnership.claimAutocal({ kind: "autocalibration", runId: "hw-1", label: "100 pots", interruptForManual, stop: vi.fn() });
    expect(controllerOwnership.interruptAutocalForManual("solenoid 74")).toBe(true);
    expect(interruptForManual).toHaveBeenCalledWith("solenoid 74");
    release();
    expect(controllerOwnership.interruptAutocalForManual("solenoid 74")).toBe(false);
  });

  it("the shared Stop ends this tab's hold and its run", () => {
    const stopHold = vi.fn();
    const stopRun = vi.fn();
    controllerOwnership.claimAutocal({ kind: "autocalibration", runId: "hw-2", label: "8 pots", interruptForManual: vi.fn(), stop: stopRun });
    controllerOwnership.claimHold({ kind: "manual_hold", sessionId: "s1", label: "Pot 16", stop: stopHold });
    controllerOwnership.stopAll();
    expect(stopHold).toHaveBeenCalledTimes(1);
    expect(stopRun).toHaveBeenCalledTimes(1);
  });

  it("a stale release cannot clear a newer claim", () => {
    const first = controllerOwnership.claimHold({ kind: "manual_hold", sessionId: "old", label: "Pot 1", stop: vi.fn() });
    controllerOwnership.claimHold({ kind: "manual_hold", sessionId: "new", label: "Pot 2", stop: vi.fn() });
    first();
    expect(controllerOwnership.getSnapshot().hold?.sessionId).toBe("new");
  });
});

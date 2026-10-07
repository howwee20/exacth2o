import { describe, expect, it } from "vitest";
import { combinedStage, describeCommandProgress, trackedCommandProgress } from "./commandLifecycle";

describe("command lifecycle", () => {
  it("never reports a watering command as physically verified", () => {
    const progress = describeCommandProgress({ label: "Manual water", commandType: "manual_water", stage: "executed", controllerOnline: true });
    expect(progress.title).toBe("Manual water: controller reported complete");
    expect(progress.detail).toMatch(/not physically verified/);
    expect(progress.physicallyVerified).toBe(false);
    expect(progress.hasPhysicalOutcome).toBe(true);
  });

  it("says a queued request has not changed anything, and why when the controller is offline", () => {
    expect(describeCommandProgress({ label: "Update pairing", commandType: "update_pairing", stage: "queued", controllerOnline: true }).detail)
      .toMatch(/Nothing has changed yet/);
    const offline = describeCommandProgress({ label: "Update pairing", commandType: "update_pairing", stage: "queued", controllerOnline: false });
    expect(offline.tone).toBe("warning");
    expect(offline.detail).toMatch(/controller is offline/);
  });

  it("reports a batch at its least advanced step, and any failure as failed", () => {
    expect(combinedStage(["succeeded", "running", "queued"])).toBe("queued");
    expect(combinedStage(["succeeded", "succeeded"])).toBe("executed");
    expect(combinedStage(["succeeded", "failed", "queued"])).toBe("failed");
    expect(combinedStage([undefined, "queued"])).toBe("requested");
  });

  it("follows a tracked command as realtime status arrives", () => {
    const tracked = { ids: ["a"], label: "Manual water", commandType: "manual_water", requestedAt: "2026-10-07T16:00:00Z", statuses: { a: "queued" as const } };
    expect(trackedCommandProgress(tracked, true).stage).toBe("queued");
    expect(trackedCommandProgress({ ...tracked, statuses: { a: "succeeded" } }, true).terminal).toBe(true);
  });
});

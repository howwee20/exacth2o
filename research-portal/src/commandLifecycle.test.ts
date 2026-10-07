import { describe, expect, it } from "vitest";
import { combinedStage, describeCommandProgress, describeSettingsBatch, trackedCommandProgress } from "./commandLifecycle";

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

  it("describes a settings batch by the step it has reached, not its least advanced step", () => {
    const batch = (statuses: Parameters<typeof describeSettingsBatch>[0]["statuses"], restoresTo = "running") =>
      describeSettingsBatch({ label: "Reviewed settings", statuses, restoresTo, controllerOnline: true,
        stepLabels: ["Stop controller", "Update pairing", "Restore running"] });

    const waiting = batch(["queued", "queued", "queued"]);
    expect(waiting.detail).toBe("Queued. Nothing has changed yet.");
    expect(waiting.steps?.map((step) => step.state)).toEqual(["current", "pending", "pending"]);

    // The stop has run: the controller is stopped, so "nothing has changed" would be false.
    const applying = batch(["succeeded", "running", "queued"]);
    expect(applying.title).toBe("Reviewed settings: update pairing (step 2 of 3)");
    expect(applying.detail).toMatch(/has stopped/);
    expect(applying.detail).not.toMatch(/Nothing has changed/);
    expect(applying.terminal).toBe(false);

    const restoring = batch(["succeeded", "succeeded", "queued"]);
    expect(restoring.detail).toMatch(/stopped until this step returns it/);
  });

  it("says when a failed or expired step leaves the controller stopped", () => {
    const run = (statuses: Parameters<typeof describeSettingsBatch>[0]["statuses"], restoresTo = "running") =>
      describeSettingsBatch({ label: "Reviewed settings", statuses, restoresTo, controllerOnline: true });

    const restoreExpired = run(["succeeded", "succeeded", "expired"]);
    expect(restoreExpired.terminal).toBe(true);
    expect(restoreExpired.tone).toBe("bad");
    expect(restoreExpired.title).toBe("Reviewed settings: applied, not restored");
    expect(restoreExpired.detail).toMatch(/probably still stopped/);
    expect(restoreExpired.detail).not.toMatch(/Nothing changed/);

    const changeFailed = run(["succeeded", "failed", "canceled"]);
    expect(changeFailed.title).toBe("Reviewed settings: stopped part-way");
    expect(changeFailed.detail).toMatch(/remaining steps were canceled/);
    expect(changeFailed.detail).toMatch(/probably still stopped/);
    expect(changeFailed.steps?.map((step) => step.state)).toEqual(["done", "stopped", "stopped"]);

    const stopExpired = run(["expired", "canceled", "canceled"]);
    expect(stopExpired.detail).toMatch(/No settings changed/);
    expect(stopExpired.tone).toBe("warning");

    // A controller that was already stopped is not described as left stopped by the failure.
    expect(run(["succeeded", "failed", "canceled"], "stopped").detail).toMatch(/was stopped beforehand/);

    const done = run(["succeeded", "succeeded", "succeeded"]);
    expect(done.terminal).toBe(true);
    expect(done.detail).toMatch(/returned to its previous state/);
  });

  it("routes settings batches through the step description and flags abandoned tracking", () => {
    const tracked = {
      ids: ["s", "c", "r"], label: "Reviewed settings", commandType: "settings_batch", requestedAt: "2026-10-07T16:00:00Z",
      statuses: { s: "succeeded" as const, c: "queued" as const, r: "queued" as const }, restoresTo: "running",
    };
    expect(trackedCommandProgress(tracked, true).steps).toHaveLength(3);
    const abandoned = trackedCommandProgress({ ...tracked, trackingStopped: true }, true);
    expect(abandoned.tone).toBe("warning");
    expect(abandoned.detail).toMatch(/stopped checking/);
  });
});

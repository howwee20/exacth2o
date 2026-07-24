import { describe, expect, it } from "vitest";

import {
  activeControlCommandCount,
  controlActivityStatusLabel,
  visibleControlCommands,
  type ControlActivityItem,
} from "./controlActivity";

function command(
  id: string,
  status: ControlActivityItem["status"],
  requestedAt: string,
): ControlActivityItem {
  return { id, status, requested_at: requestedAt };
}

describe("control activity", () => {
  it("puts active work ahead of newer completed work", () => {
    const visible = visibleControlCommands([
      command("complete", "succeeded", "2026-07-24T12:00:00.000Z"),
      command("queued", "queued", "2026-07-24T11:00:00.000Z"),
      command("running", "running", "2026-07-24T10:00:00.000Z"),
    ]);

    expect(visible.map((item) => item.id)).toEqual([
      "queued",
      "running",
      "complete",
    ]);
    expect(activeControlCommandCount(visible)).toBe(2);
  });

  it("uses concise customer-facing status labels", () => {
    expect(controlActivityStatusLabel("succeeded")).toBe("Complete");
    expect(controlActivityStatusLabel("running")).toBe("Running");
  });
});

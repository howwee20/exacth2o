import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescedTrigger, scheduleVisiblePolling, type VisibilityDocument } from "./visiblePolling";

function fakeDocument() {
  const target = new EventTarget();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    setVisibility(state: DocumentVisibilityState) {
      this.visibilityState = state;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return doc as VisibilityDocument & { setVisibility: (state: DocumentVisibilityState) => void };
}

describe("scheduleVisiblePolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls while visible, pauses while hidden, and catches up once on return", () => {
    const doc = fakeDocument();
    const task = vi.fn();
    const stop = scheduleVisiblePolling(task, 60_000, { doc });

    vi.advanceTimersByTime(120_000);
    expect(task).toHaveBeenCalledTimes(2);

    doc.setVisibility("hidden");
    vi.advanceTimersByTime(30 * 60_000);
    expect(task).toHaveBeenCalledTimes(2);

    doc.setVisibility("visible");
    expect(task).toHaveBeenCalledTimes(3);
    // Returning again immediately does not trigger another run.
    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    expect(task).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("never overlaps a slow request with the next tick", async () => {
    const doc = fakeDocument();
    let resolve!: () => void;
    const task = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const stop = scheduleVisiblePolling(task, 1_000, { doc });
    vi.advanceTimersByTime(5_000);
    expect(task).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps polling after a failed run", async () => {
    const doc = fakeDocument();
    const task = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const stop = scheduleVisiblePolling(task, 1_000, { doc });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("createCoalescedTrigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses focus, visibility and pageshow bursts into one reconciliation", () => {
    const task = vi.fn();
    const trigger = createCoalescedTrigger(task, { minSpacingMs: 30_000 });
    trigger.trigger("visibilitychange");
    trigger.trigger("focus");
    trigger.trigger("pageshow");
    vi.advanceTimersByTime(300);
    expect(task).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenLastCalledWith("pageshow");

    // Clicking back into the window ten seconds later does not refetch.
    vi.advanceTimersByTime(10_000);
    trigger.trigger("focus");
    vi.advanceTimersByTime(300);
    expect(task).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    trigger.trigger("online");
    vi.advanceTimersByTime(300);
    expect(task).toHaveBeenCalledTimes(2);
  });
});

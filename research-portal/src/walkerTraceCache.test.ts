import { beforeEach, expect, it, vi } from "vitest";
import type { WalkerLiveSnapshot } from "./walkerObservation";
import type { WalkerPortalExperiment } from "./walkerExperiments";
const backend = vi.hoisted(() => ({ snapshot: vi.fn(), record: vi.fn() }));
vi.mock("./walkerObservationClient", () => ({ loadWalkerLiveSnapshot: backend.snapshot }));
vi.mock("./walkerExperimentClient", () => ({ loadWalkerExperiment: backend.record }));
import { cachedWalkerExperiment, clearWalkerTraceCache, loadWalkerTraceExperiment, loadWalkerTraceSnapshot, rememberWalkerExperiments } from "./walkerTraceCache";
const snapshot = { project_id: "walker", sensors: [], series: [] } as unknown as WalkerLiveSnapshot;
const record = { id: "trial", name: "Trial" } as WalkerPortalExperiment;
beforeEach(() => { clearWalkerTraceCache(); vi.restoreAllMocks(); backend.snapshot.mockReset().mockResolvedValue(snapshot); backend.record.mockReset().mockResolvedValue(record); });
it("shares the lookahead with a click and expires it before the next poll", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const first = loadWalkerTraceSnapshot("alice");
  expect(loadWalkerTraceSnapshot("alice")).toBe(first);
  expect(await first).toBe(snapshot);
  expect(await loadWalkerTraceSnapshot("alice")).toBe(snapshot);
  expect(backend.snapshot).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(31_001);
  await loadWalkerTraceSnapshot("alice");
  expect(backend.snapshot).toHaveBeenCalledTimes(2);
});
it("keeps live and last-recorded windows separate and never shares accounts", async () => {
  await loadWalkerTraceSnapshot("alice");
  await loadWalkerTraceSnapshot("alice", true);
  await loadWalkerTraceSnapshot("bob");
  expect(backend.snapshot.mock.calls).toEqual([[false], [true], [false]]);
});
it("does not repopulate a cleared session with an old in-flight response", async () => {
  let finish!: (value: WalkerLiveSnapshot) => void;
  backend.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = loadWalkerTraceSnapshot("alice");
  clearWalkerTraceCache();
  finish(snapshot);
  await pending;
  await loadWalkerTraceSnapshot("alice");
  expect(backend.snapshot).toHaveBeenCalledTimes(2);
});
it("reuses the home catalog but reloads expired or other-user records", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  rememberWalkerExperiments("alice", [record]);
  expect(await loadWalkerTraceExperiment("alice", "trial")).toBe(record);
  expect(backend.record).not.toHaveBeenCalled();
  clock.mockReturnValue(31_001);
  expect(cachedWalkerExperiment("alice", "trial")).toBeNull();
  await loadWalkerTraceExperiment("alice", "trial");
  expect(cachedWalkerExperiment("bob", "trial")).toBeNull();
  expect(backend.record).toHaveBeenCalledTimes(1);
});
it("retries a failed lookahead when traces open", async () => {
  backend.snapshot.mockRejectedValueOnce(new Error("offline"));
  await expect(loadWalkerTraceSnapshot("alice")).rejects.toThrow("offline");
  expect(await loadWalkerTraceSnapshot("alice")).toBe(snapshot);
  expect(backend.snapshot).toHaveBeenCalledTimes(2);
});

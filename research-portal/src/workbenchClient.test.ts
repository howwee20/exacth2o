import { afterEach, describe, expect, it, vi } from "vitest";
import { loadExclusions } from "./workbenchClient";

const { range, from, order } = vi.hoisted(() => ({ range: vi.fn(), from: vi.fn(), order: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from } }));

function installPages(rows: unknown[], failAt?: number) {
  const query = { select: () => query, eq: () => query, order, range };
  order.mockImplementation(() => query);
  from.mockImplementation(() => query);
  range.mockImplementation(async (first: number, last: number) => first === failAt
    ? { data: null, error: { message: "Connection lost" } }
    : { data: rows.slice(first, last + 1), error: null });
}
function exclusions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `exclusion-${i}`, pairing_name: null, starts_at: null, ends_at: null, reason: `Reason ${i}`,
    author_label: "Researcher", created_at: "2026-10-08T12:00:00Z",
    revoked_at: i < 500 ? "2026-10-08T13:00:00Z" : null, revoked_by_label: i < 500 ? "Researcher" : null,
    revoke_reason: i < 500 ? "Restored the data" : null,
  }));
}
afterEach(() => { vi.resetAllMocks(); });

describe("complete exclusion history", () => {
  it("reads beyond 500 revoked rows so a later active exclusion is retained", async () => {
    installPages(exclusions(501));
    const result = await loadExclusions("comparison-a");
    expect(result).toHaveLength(501);
    expect(result[500]).toMatchObject({ id: "exclusion-500", revokedAt: null });
    expect(range.mock.calls).toEqual([[0, 499], [500, 999]]);
    expect(order.mock.calls).toContainEqual(["id", { ascending: true }]);
  });

  it("refuses a partial history if a later page fails", async () => {
    installPages(exclusions(501), 500);
    await expect(loadExclusions("comparison-a")).rejects.toThrow(/could not be fully loaded: Connection lost/);
  });

  it("refuses history over the bounded cap instead of silently truncating it", async () => {
    installPages(exclusions(10_001));
    await expect(loadExclusions("comparison-a")).rejects.toThrow(/incomplete exclusion history/);
    expect(range.mock.calls.at(-1)).toEqual([10_000, 10_000]);
  });
});

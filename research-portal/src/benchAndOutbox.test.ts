import { describe, expect, it } from "vitest";
import { boardGroups, draftFromSchematic, layoutProblems, recordedLayout, schematicLayout } from "./benchLayout";
import {
  afterAttempt,
  dueEntries,
  inScope,
  memoryStore,
  newNoteId,
  newOutboxEntry,
  prunable,
  retryDelayMs,
  syncOutbox,
  type OutboxEntry,
  type SendOutcome,
} from "./noteOutbox";
import type { PairingRow } from "./types";

const base = {
  userId: "user-a",
  projectId: "project-1",
  deviceId: "controller-1",
  pairingName: "Zone3-Pot17",
  researchPotId: null,
  experimentId: null,
  body: "  Reseated the B3 ribbon cable.  ",
  tags: ["sensor reseated"],
  observedAt: "2026-10-08T15:04:00.000Z",
  authorLabel: "tech@example.invalid",
  supersedesId: null,
  writtenOffline: true,
};

function entry(overrides: Partial<OutboxEntry> = {}, nowMs = Date.parse("2026-10-08T15:04:00Z")) {
  return { ...newOutboxEntry({ ...base, id: newNoteId() }, nowMs), ...overrides };
}

describe("note outbox", () => {
  it("creates pending entries with stable ids and the writer's time", () => {
    const first = entry();
    expect(first.state).toBe("pending");
    expect(first.body).toBe("Reseated the B3 ribbon cable.");
    expect(first.observedAt).toBe(base.observedAt);
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(Array.from({ length: 50 }, () => newNoteId())).size).toBe(50);
  });

  it("keeps each account's notes to that account and project", () => {
    const mine = entry();
    expect(inScope(mine, "user-a", "project-1")).toBe(true);
    expect(inScope(mine, "user-b", "project-1")).toBe(false);
    expect(inScope(mine, "user-a", "project-2")).toBe(false);
    expect(inScope(mine, null, "project-1")).toBe(false);
  });

  it("backs off after network failures, waits for sign-in, and never retries a refusal by itself", () => {
    const now = Date.parse("2026-10-08T15:10:00Z");
    const pending = entry();
    expect(dueEntries([pending], now)).toHaveLength(1);
    const afterNetwork = afterAttempt(pending, { kind: "network", message: "offline" }, new Date(now).toISOString());
    expect(afterNetwork.state).toBe("pending");
    expect(dueEntries([afterNetwork], now + 1_000)).toHaveLength(0);
    expect(dueEntries([afterNetwork], now + retryDelayMs(1) + 1)).toHaveLength(1);
    const afterAuth = afterAttempt(pending, { kind: "auth", message: "JWT expired" });
    expect(afterAuth).toMatchObject({ state: "pending", needsSignIn: true });
    const refused = afterAttempt(pending, { kind: "rejected", message: "The note time is outside the accepted window." });
    expect(refused.state).toBe("failed");
    expect(dueEntries([refused], now + 3_600_000)).toHaveLength(0);
    expect(retryDelayMs(30)).toBe(5 * 60_000);
  });

  it("recovers a send interrupted by a reload", () => {
    const now = Date.parse("2026-10-08T15:10:00Z");
    const interrupted = entry({ state: "sending", lastAttemptAt: new Date(now - 60_000).toISOString() });
    expect(dueEntries([interrupted], now)).toHaveLength(1);
    expect(dueEntries([{ ...interrupted, lastAttemptAt: new Date(now - 5_000).toISOString() }], now)).toHaveLength(0);
  });

  it("sends oldest first, stops at the first connection problem, and keeps sent notes only briefly", async () => {
    const now = Date.parse("2026-10-08T15:10:00Z");
    const a = entry({ createdAt: "2026-10-08T15:01:00.000Z" });
    const b = entry({ createdAt: "2026-10-08T15:02:00.000Z" });
    const c = entry({ createdAt: "2026-10-08T15:03:00.000Z" });
    const other = entry({ userId: "user-b", createdAt: "2026-10-08T15:00:00.000Z" });
    const store = memoryStore([c, b, a, other]);
    const sent: string[] = [];
    const sender = async (item: OutboxEntry): Promise<SendOutcome> => {
      sent.push(item.id);
      return item.id === b.id ? { kind: "network", message: "Failed to fetch" } : { kind: "sent", atIso: new Date(now).toISOString() };
    };
    await syncOutbox(store, { userId: "user-a", projectId: "project-1" }, sender, now);
    expect(sent).toEqual([a.id, b.id]);
    const after = new Map((await store.all()).map((item) => [item.id, item]));
    expect(after.get(a.id)?.state).toBe("sent");
    expect(after.get(b.id)?.state).toBe("pending");
    expect(after.get(c.id)?.state).toBe("pending");
    expect(after.get(other.id)?.state).toBe("pending");
    expect(prunable(after.get(a.id) as OutboxEntry, now + 8 * 24 * 3_600_000)).toBe(true);
    expect(prunable(after.get(b.id) as OutboxEntry, now + 30 * 24 * 3_600_000)).toBe(false);
  });

  it("a repeated send of the same note is harmless because the id is fixed", async () => {
    const note = entry();
    const store = memoryStore([note]);
    const received = new Set<string>();
    const sender = async (item: OutboxEntry): Promise<SendOutcome> => {
      received.add(item.id);
      return { kind: "sent", atIso: new Date().toISOString() };
    };
    await syncOutbox(store, { userId: "user-a", projectId: "project-1" }, sender);
    await store.put({ ...note, state: "pending" });
    await syncOutbox(store, { userId: "user-a", projectId: "project-1" }, sender);
    expect(received.size).toBe(1);
  });
});

function pairing(zone: number, pot: number, board: string): PairingRow {
  return {
    id: pot, name: `Zone${zone}-Pot${pot}`, zone, pot_number: pot, source_sensor_id: pot, sensor_key: `${board}:${pot}`,
    source_valve_id: pot, valve_key: `0x20:${pot}`, wtc_percent_limit: 30, valve_open_time_ms: 3000, measurement_interval_ms: 600000,
  };
}

describe("bench layout", () => {
  const pairings = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((pot) => pairing(pot <= 6 ? 1 : 2, pot, pot <= 8 ? "B1" : "B2"));

  it("draws an explicitly schematic layout by zone and pot number when nothing is recorded", () => {
    const model = schematicLayout(pairings);
    expect(model.basis).toBe("schematic");
    expect(model.benches.map((bench) => [bench.label, bench.cells.length, bench.rows, bench.columns])).toEqual([["Zone 1", 6, 1, 6], ["Zone 2", 4, 1, 4]]);
  });

  it("uses a recorded layout and lists pots it does not place", () => {
    const document = { benches: [{ id: "A", label: "Bench A", rows: 2, columns: 4 }], positions: [{ pairing_name: "Zone1-Pot1", bench: "A", row: 2, column: 3 }] };
    const model = recordedLayout(document, pairings);
    expect(model.basis).toBe("recorded");
    expect(model.benches[0].cells[0]).toMatchObject({ potNumber: 1, row: 2, column: 3, sensorBoard: "B1" });
    expect(model.unplaced).toHaveLength(9);
  });

  it("explains the same problems the database refuses", () => {
    expect(layoutProblems(draftFromSchematic(pairings))).toEqual([]);
    const problems = layoutProblems({
      benches: [{ id: "A", label: "Bench A", rows: 1, columns: 2 }],
      positions: [
        { pairing_name: "Zone1-Pot1", bench: "A", row: 1, column: 1 },
        { pairing_name: "Zone1-Pot2", bench: "A", row: 1, column: 1 },
        { pairing_name: "Zone1-Pot3", bench: "A", row: 2, column: 1 },
        { pairing_name: "Zone1-Pot1", bench: "B", row: 1, column: 1 },
      ],
    });
    expect(problems.join(" ")).toMatch(/share/);
    expect(problems.join(" ")).toMatch(/outside/);
    expect(problems.join(" ")).toMatch(/does not exist/);
  });

  it("groups pots by sensor board", () => {
    expect(boardGroups(pairings).map((group) => [group.board, group.pairings.length])).toEqual([["B1", 8], ["B2", 2]]);
  });
});

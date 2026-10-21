import { describe, expect, it } from "vitest";
import {
  chamberCommandReceiptOverdue,
  chamberCommandReceiptTimeoutMs,
  chamberStatusIntervals,
  chamberStatusReadDue,
} from "./chamberStatusPolling";

function readsOverOneMinute(pending: boolean) {
  let last: number | null = null;
  let reads = 0;
  for (let tick = 0; tick < 60; tick += 1) {
    // Real timers drift a little on every tick.
    const now = tick * chamberStatusIntervals.tickMs + (tick % 3) * 7;
    if (chamberStatusReadDue(now, last, pending)) {
      reads += 1;
      last = now;
    }
  }
  return reads;
}

describe("chamber status polling", () => {
  it("reads every second only while a command awaits its receipt", () => {
    expect(readsOverOneMinute(true)).toBe(60);
    expect(readsOverOneMinute(false)).toBe(12);
  });

  it("always reads first, and immediately once a command becomes pending", () => {
    expect(chamberStatusReadDue(0, null, false)).toBe(true);
    expect(chamberStatusReadDue(1_000, 0, false)).toBe(false);
    expect(chamberStatusReadDue(1_000, 0, true)).toBe(true);
  });

  it("marks a command unconfirmed after the receipt timeout, which exceeds every command TTL", () => {
    // Native mixer commands live 15 s, lighting 20 s (database CHECK constraints).
    expect(chamberCommandReceiptTimeoutMs).toBeGreaterThan(20_000);
    expect(chamberCommandReceiptOverdue(0, chamberCommandReceiptTimeoutMs - 1)).toBe(false);
    expect(chamberCommandReceiptOverdue(0, chamberCommandReceiptTimeoutMs)).toBe(true);
  });
});

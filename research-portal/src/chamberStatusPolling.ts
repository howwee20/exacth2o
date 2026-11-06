/**
 * Chamber status panels read the controller every second only while one of
 * their commands awaits a receipt; otherwise every five seconds. Each read
 * also tells the agent someone is watching, so its displayed state stays
 * fresh. The one-second tick still drives the "last contact" clock.
 */
export const chamberStatusIntervals = { tickMs: 1_000, pendingMs: 1_000, idleMs: 5_000 } as const;

/** A command older than this without a terminal receipt is shown as unconfirmed. */
export const chamberCommandReceiptTimeoutMs = 30_000;

export function chamberStatusReadDue(nowMs: number, lastReadMs: number | null, commandPending: boolean) {
  if (lastReadMs === null) return true;
  const interval = commandPending ? chamberStatusIntervals.pendingMs : chamberStatusIntervals.idleMs;
  // Ticks drift by a few milliseconds; do not skip a whole extra tick for it.
  return nowMs - lastReadMs >= interval - 100;
}

export function chamberCommandReceiptOverdue(sentAtMs: number, nowMs: number) {
  return nowMs - sentAtMs >= chamberCommandReceiptTimeoutMs;
}

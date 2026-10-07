/**
 * Polling that pauses while the page is hidden and catches up once on return.
 *
 * Background tabs do not need five-minute health or support refreshes, but a
 * researcher returning to the tab must see reconciled state immediately. Runs
 * never overlap: a tick that arrives while the previous run is still in flight
 * is skipped rather than queued.
 */

export type VisibilityDocument = Pick<Document, "addEventListener" | "removeEventListener"> & {
  readonly visibilityState: DocumentVisibilityState;
};

export type PollingTimers = {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
};

const defaultTimers: PollingTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  now: () => Date.now(),
};

export function scheduleVisiblePolling(
  task: () => unknown,
  intervalMs: number,
  options: {
    doc?: VisibilityDocument;
    timers?: PollingTimers;
    /** Run once on return when a poll was missed (default). Disable when another path reconciles on return. */
    catchUpOnVisible?: boolean;
  } = {},
) {
  const doc = options.doc ?? (typeof document === "undefined" ? null : document);
  const timers = options.timers ?? defaultTimers;
  let inFlight = false;
  let lastRunAt = timers.now();
  let disposed = false;

  const run = () => {
    if (disposed || inFlight) return;
    inFlight = true;
    lastRunAt = timers.now();
    let result: unknown;
    try {
      result = task();
    } catch {
      inFlight = false;
      return;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      Promise.resolve(result).catch(() => undefined).finally(() => {
        inFlight = false;
      });
    } else {
      inFlight = false;
    }
  };

  const visible = () => !doc || doc.visibilityState === "visible";

  const handle = timers.setInterval(() => {
    if (visible()) run();
  }, intervalMs);

  const onVisibilityChange = () => {
    // Catch up only when a scheduled run was actually missed while hidden.
    if (visible() && timers.now() - lastRunAt >= intervalMs) run();
  };
  const catchUp = options.catchUpOnVisible !== false;
  if (catchUp) doc?.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    disposed = true;
    timers.clearInterval(handle);
    if (catchUp) doc?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/**
 * Collapses bursts of triggers (focus, visibilitychange, pageshow and online
 * often fire together) into one call, and enforces a minimum spacing.
 */
export function createCoalescedTrigger(
  task: (reason: string) => unknown,
  options: { minSpacingMs: number; settleMs?: number; now?: () => number; setTimer?: (callback: () => void, ms: number) => unknown; clearTimer?: (handle: unknown) => void },
) {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const settleMs = options.settleMs ?? 250;
  let lastRunAt = -Infinity;
  let pending: unknown = null;
  let pendingReason = "";

  const fire = () => {
    pending = null;
    if (now() - lastRunAt < options.minSpacingMs) return;
    lastRunAt = now();
    task(pendingReason);
  };

  return {
    trigger(reason: string) {
      pendingReason = reason;
      if (pending != null) clearTimer(pending);
      pending = setTimer(fire, settleMs);
    },
    /** Record a run that happened through another path so it is not repeated. */
    markRun() {
      lastRunAt = now();
    },
    cancel() {
      if (pending != null) clearTimer(pending);
      pending = null;
    },
  };
}

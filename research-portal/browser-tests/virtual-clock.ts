// LOCAL PREVIEW AND BROWSER TESTS ONLY. Runs the page's clock faster than real time,
// so a simulated 100-pot run (about ten hours) can be watched in minutes. Timers,
// Date and performance.now all move together; nothing here touches a real controller.
// The speed can change while the page runs (window.__setClockSpeed).

let speed = 1;

export function installVirtualClock(initialSpeed: number) {
  const realNow = Date.now.bind(Date);
  const realPerf = performance.now.bind(performance);
  let baseVirtual = realNow();
  let baseReal = baseVirtual;
  let basePerfVirtual = realPerf();
  let basePerfReal = basePerfVirtual;
  speed = initialSpeed > 0 ? initialSpeed : 1;
  const virtual = () => baseVirtual + (realNow() - baseReal) * speed;
  const virtualPerf = () => basePerfVirtual + (realPerf() - basePerfReal) * speed;
  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(virtual());
      else super(...(args as [string | number | Date]));
    }
    static now() {
      return virtual();
    }
  }
  (window as unknown as { Date: DateConstructor }).Date = VirtualDate as unknown as DateConstructor;
  performance.now = virtualPerf;
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, timeout = 0, ...rest: unknown[]) => realSetTimeout(handler, Math.max(0, Number(timeout) / speed), ...rest)) as typeof window.setTimeout;
  // Intervals re-read the speed on every tick, so a speed change applies to timers already running.
  const intervals = new Map<number, ReturnType<typeof realSetTimeout>>();
  let nextInterval = 1_000_000_000;
  window.setInterval = ((handler: TimerHandler, timeout = 0, ...rest: unknown[]) => {
    const id = nextInterval++;
    const schedule = () => {
      intervals.set(id, realSetTimeout(() => {
        if (!intervals.has(id)) return;
        schedule();
        if (typeof handler === "function") (handler as (...args: unknown[]) => void)(...rest);
      }, Math.max(1, Number(timeout) / speed)));
    };
    schedule();
    return id;
  }) as typeof window.setInterval;
  const clear = (id?: number) => {
    if (id != null && intervals.has(id)) {
      realClearTimeout(intervals.get(id));
      intervals.delete(id);
      return;
    }
    realClearTimeout(id);
  };
  window.clearInterval = clear as typeof window.clearInterval;
  window.clearTimeout = clear as typeof window.clearTimeout;
  (window as unknown as { __setClockSpeed: (next: number) => void }).__setClockSpeed = (next: number) => {
    baseVirtual = virtual();
    baseReal = realNow();
    basePerfVirtual = virtualPerf();
    basePerfReal = realPerf();
    speed = next > 0 ? next : 1;
    window.dispatchEvent(new Event("preview-clock"));
  };
}

export function clockSpeed() {
  return speed;
}

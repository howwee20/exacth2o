import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../site-brand-footer.js", import.meta.url), "utf8");
const empty = "M600 250H1040V260H600Z";

function harness({ reducedMotion = false, hidden = false } = {}) {
  const events = new Map<string, () => void>();
  const frames = new Map<number, (at: number) => void>();
  let serial = 0;
  let now = 0;
  let path = empty;
  let onIntersection: (entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void;
  const surface = { setAttribute: (_name: string, value: string) => { path = value; } };
  const logo = { querySelector: () => surface };
  const motion = {
    matches: reducedMotion,
    addEventListener: (name: string, callback: () => void) => events.set(`motion:${name}`, callback),
  };
  const document = {
    hidden,
    querySelector: () => logo,
    addEventListener: (name: string, callback: () => void) => events.set(name, callback),
  };

  vm.runInNewContext(source, {
    document,
    window: {
      matchMedia: () => motion,
      addEventListener: (name: string, callback: () => void) => events.set(name, callback),
    },
    IntersectionObserver: class {
      constructor(callback: typeof onIntersection) { onIntersection = callback; }
      observe() {}
    },
    requestAnimationFrame: (callback: (at: number) => void) => {
      frames.set(++serial, callback);
      return serial;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });

  function tick(milliseconds = 16) {
    now += milliseconds;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  }

  function intersect(isIntersecting = true, intersectionRatio = 0.6) {
    onIntersection([{ isIntersecting, intersectionRatio }]);
  }

  function fill() {
    intersect();
    tick();
    tick(200);
  }

  return { document, motion, events, intersect, tick, fill, active: () => frames.size, path: () => path };
}

describe("footer arrival animation", () => {
  it("fills when at least 60 percent is visible, then drains and releases its frame", () => {
    const h = harness();
    expect(h.active()).toBe(0);
    h.intersect(true, 0.59);
    expect(h.active()).toBe(0);
    h.fill();
    expect(h.path()).toContain("h440");
    h.tick(2000);
    expect(h.path()).toBe(empty);
    expect(h.active()).toBe(0);
  });

  it("plays once per arrival and can play again after leaving view", () => {
    const h = harness();
    h.fill();
    h.tick(2000);
    h.intersect();
    expect(h.active()).toBe(0);
    h.intersect(false, 0);
    h.fill();
    expect(h.path()).toContain("h440");
  });

  it("clears the animation when the footer leaves its visibility threshold", () => {
    const h = harness();
    h.fill();
    h.intersect(true, 0.59);
    expect(h.path()).toBe(empty);
    expect(h.active()).toBe(0);
  });

  it("skips arrivals while the document is hidden or reduced motion is enabled", () => {
    for (const options of [{ hidden: true }, { reducedMotion: true }]) {
      const h = harness(options);
      h.fill();
      expect(h.path()).toBe(empty);
      expect(h.active()).toBe(0);
    }
  });

  it("cancels active frames on page hiding or a motion preference change", () => {
    for (const reason of ["visibilitychange", "motion:change", "pagehide"]) {
      const h = harness();
      h.fill();
      expect(h.path()).toContain("h440");
      if (reason === "visibilitychange") h.document.hidden = true;
      if (reason === "motion:change") h.motion.matches = true;
      h.events.get(reason)!();
      expect(h.path()).toBe(empty);
      expect(h.active()).toBe(0);
    }
  });
});

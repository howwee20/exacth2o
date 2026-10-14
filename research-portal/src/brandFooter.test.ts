import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../site-brand-footer.js', import.meta.url), 'utf8');
function harness() {
  const events: Record<string, (event?: Record<string, unknown>) => void> = {};
  const callbacks = new Map<number, (at: number) => void>();
  let serial = 0, now = 0, path = '', bottom = true;
  const surface = { setAttribute: (_: string, value: string) => { path = value; } };
  const logo = { querySelector: () => surface, getBoundingClientRect: () => ({top: 500, bottom: 700}) };
  const motion = {matches: false, addEventListener: (name: string, fn: () => void) => {events[`motion:${name}`] = fn;} };
  const document = { hidden: false, querySelector: () => logo, get scrollingElement() {return {scrollHeight: bottom ? 900 : 2000};}, addEventListener: (name: string, fn: () => void) => {events[name] = fn;} };
  const window = {scrollY: 0, innerHeight: 900, matchMedia: () => motion, addEventListener: (name: string, fn: () => void) => {events[name] = fn;} };
  class Element { closest() { return true; } }
  vm.runInNewContext(source, {window, document, Element, performance: {now: () => now}, requestAnimationFrame: (fn: (at:number)=>void) => {callbacks.set(++serial, fn);return serial;}, cancelAnimationFrame: (id:number) => callbacks.delete(id)});
  function tick(ms=16) { now += ms; const pending=[...callbacks.values()]; callbacks.clear(); pending.forEach(fn=>fn(now)); }
  return {events, motion, document, Element, tick, away: () => {bottom=false;}, active: () => callbacks.size, path: () => path};
}
describe('footer animation lifecycle', () => {
  it('fills after downward input, then drains and releases every frame', () => {
    const h=harness(); h.events.wheel({deltaY:300,deltaMode:0}); h.tick(); h.tick(); h.tick(300);
    expect(h.path()).toContain('h440');
    for(let i=0;i<100;i++) h.tick();
    expect(h.path()).toBe('M600 250H1040V260H600Z'); expect(h.active()).toBe(0);
  });
  it('does not animate away from the footer or in reduced motion', () => {
    const h=harness(); h.away(); h.events.wheel({deltaY:300}); expect(h.active()).toBe(0);
    const m=harness(); m.motion.matches=true; m.events.keydown({key:'End'}); expect(m.active()).toBe(0);
  });
  it('stops immediately when hidden or the motion preference changes', () => {
    for(const reason of ['hidden','motion']) {
      const h=harness(); h.events.wheel({deltaY:300}); h.tick(); h.tick();
      if(reason==='hidden') {h.document.hidden=true; h.events.visibilitychange();}
      else {h.motion.matches=true; h.events['motion:change']();}
      expect(h.active()).toBe(0); expect(h.path()).toBe('M600 250H1040V260H600Z');
    }
  });
  it('leaves form input and zoom gestures alone', () => {
    const h=harness(); h.events.keydown({key:'End',target:new h.Element()});
    h.events.wheel({deltaY:300,ctrlKey:true}); expect(h.active()).toBe(0);
  });
});

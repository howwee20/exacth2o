import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../site-brand-footer.js', import.meta.url), 'utf8');
const empty = 'M600 250H1040V260H600Z';
function harness(start=700) {
  const events: Record<string, (event?: Record<string, unknown>) => void> = {};
  const callbacks = new Map<number, (at: number) => void>();
  let serial=0, now=0, path=empty;
  const surface = {setAttribute: (_: string, value: string) => {path=value;}};
  const logo = {querySelector: () => surface, getBoundingClientRect: () => ({top:500,bottom:700})};
  const motion = {matches:false,addEventListener: (name: string, fn: () => void) => {events[`motion:${name}`]=fn;}};
  const document = {hidden:false,querySelector: () => logo,scrollingElement:{scrollHeight:1900},addEventListener:(name: string,fn: () => void) => {events[name]=fn;}};
  const window = {scrollY:start,innerHeight:900,matchMedia: () => motion,addEventListener:(name: string,fn: () => void) => {events[name]=fn;}};
  vm.runInNewContext(source,{window,document,performance:{now: () => now},requestAnimationFrame:(fn:(at:number)=>void) => {callbacks.set(++serial,fn);return serial;},cancelAnimationFrame:(id:number) => callbacks.delete(id)});
  function tick(ms=16) {now+=ms;const pending=[...callbacks.values()];callbacks.clear();pending.forEach(fn=>fn(now));}
  function scroll(y:number,ms=16) {tick(ms);window.scrollY=y;events.scroll();}
  function slam() {events.wheel({deltaY:300});scroll(850);scroll(1000);tick();tick(250);}
  return {events,motion,document,tick,scroll,slam,compositorArrival: () => {window.scrollY=1000;events.wheel({deltaY:900});events.scroll();tick();tick(200);},active: () => callbacks.size,path: () => path};
}
describe('footer arrival animation', () => {
  it('fills on a fast arrival, then drains and releases every frame', () => {
    const h=harness();h.slam();expect(h.path()).toContain('h440');
    for(let i=0;i<100;i++)h.tick();
    expect(h.path()).toBe(empty);expect(h.active()).toBe(0);
  });
  it('accepts a final passive wheel after the compositor reaches the bottom', () => {
    const h=harness();h.compositorArrival();expect(h.path()).toContain('h440');
  });
  it('ignores repeated wheel and touch swipes while already at the bottom', () => {
    const h=harness(1000);
    for(let i=0;i<20;i++) {h.events.wheel({deltaY:1000});h.tick();}
    h.events.touchstart({touches:[{clientY:800}]});h.events.touchmove({touches:[{clientY:100}]});h.tick();
    expect(h.path()).toBe(empty);expect(h.active()).toBe(0);
  });
  it('ignores gentle arrival, even with large incoming wheel deltas', () => {
    const h=harness(970);
    for(let y=975;y<=1000;y+=5) {h.events.wheel({deltaY:300});h.scroll(y,50);}
    expect(h.path()).toBe(empty);expect(h.active()).toBe(0);
  });
  it('ignores a final tiny movement after earlier fast scrolling', () => {
    const h=harness();h.events.wheel({deltaY:300});h.scroll(995);h.tick(300);
    h.events.wheel({deltaY:300});h.scroll(1000);
    expect(h.active()).toBe(0);
  });
  it('supports a fast touch arrival without responding to stationary touch input', () => {
    const h=harness();h.events.touchstart({touches:[{clientY:800}]});
    h.events.touchmove({touches:[{clientY:500}]});h.scroll(1000);h.tick();h.tick(200);
    expect(h.path()).toContain('h440');
  });
  it('retains touch momentum through continuous scrolling until arrival', () => {
    const h=harness(0);h.events.touchstart({touches:[{clientY:800}]});
    h.events.touchmove({touches:[{clientY:500}]});h.events.touchend();
    for(let y=100;y<=1000;y+=100)h.scroll(y,60);
    h.tick();h.tick(200);expect(h.path()).toContain('h440');
  });
  it('keeps a fast arrival through native smooth-scroll deceleration', () => {
    const h=harness(550);h.events.wheel({deltaY:900});
    for(const y of [750,870,930,960,980,990,995,998,1000])h.scroll(y,30);
    h.tick();h.tick(200);expect(h.path()).toContain('h440');
  });
  it('does not animate for programmatic, keyboard or zoom navigation', () => {
    for(const reason of ['programmatic','keyboard','zoom']) {
      const h=harness();
      if(reason==='keyboard') {h.events.wheel({deltaY:300});h.events.keydown({key:'End'});}
      if(reason==='zoom')h.events.wheel({deltaY:300,ctrlKey:true});
      h.scroll(1000);expect(h.active()).toBe(0);
    }
  });
  it('does not animate away from the footer or in reduced motion', () => {
    const h=harness();h.events.wheel({deltaY:300});h.scroll(900);expect(h.active()).toBe(0);
    const m=harness();m.motion.matches=true;m.slam();expect(m.active()).toBe(0);
  });
  it('stops immediately when hidden, resized, scrolled away or motion is reduced', () => {
    for(const reason of ['hidden','motion','resize','away']) {
      const h=harness();h.slam();
      if(reason==='hidden') {h.document.hidden=true;h.events.visibilitychange();}
      if(reason==='motion') {h.motion.matches=true;h.events['motion:change']();}
      if(reason==='resize')h.events.resize();
      if(reason==='away')h.scroll(900);
      expect(h.active()).toBe(0);expect(h.path()).toBe(empty);
    }
  });
  it('does not retrigger from the remaining inertia of the same gesture', () => {
    const h=harness();h.slam();for(let i=0;i<120;i++) {h.events.wheel({deltaY:500});h.tick();}
    expect(h.path()).toBe(empty);expect(h.active()).toBe(0);
    h.scroll(700);h.slam();expect(h.path()).toContain('h440');
  });
});

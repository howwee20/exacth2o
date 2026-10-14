// A fast arrival at the page bottom lifts the scanlines once, then lets them settle.
(() => {
  const logo = document.querySelector('.brand-finale');
  const surface = logo?.querySelector('.brand-water-level');
  if (!surface) return;
  const empty = 'M600 250H1040V260H600Z';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, touchY = null;
  let gestureAt = -Infinity, samples = [];
  let previousScroll = window.scrollY, previousTime = performance.now();
  let wasAtBottom = atBottom();
  function atBottom() {
    const page = document.scrollingElement || document.documentElement;
    const rect = logo.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0 &&
      page.scrollHeight - window.innerHeight - window.scrollY <= 3;
  }
  function settle() {
    cancelAnimationFrame(frame);
    frame = 0;
    surface.setAttribute('d', empty);
  }
  function play(strength) {
    if (frame || reducedMotion.matches || document.hidden || !atBottom()) return;
    const rise = 100 + 400 * strength, hold = rise * .4, fall = rise * .9;
    const rows = Math.max(1, Math.round(24 * strength));
    let start;
    function draw(now) {
      if (reducedMotion.matches || document.hidden || !atBottom()) { settle(); return; }
      start ??= now;
      const elapsed = now - start;
      if (elapsed >= rise + hold + fall) { settle(); return; }
      const retreat = Math.max(0, (elapsed - rise - hold) / fall);
      const fill = elapsed < rise ? 1 - (1 - elapsed / rise) ** 3 : 1 - retreat ** 2;
      const count = Math.ceil(rows * fill);
      const pulse = Math.sin(retreat * Math.PI);
      let path = '';
      for (let row = 0; row < count; row++) {
        // Narrow gaps travel through the upper stripes as the fill recedes.
        const position = row / Math.max(count, 1);
        const spacing = .08 + pulse * .12;
        const phase = (position % spacing) / spacing;
        const gap = (.02 + pulse * .04) * (1 - position * .5) / spacing;
        if (retreat > 0 && position ** 1.5 * pulse > .5 && phase > .3 && phase < .3 + gap) continue;
        const y = 208 - row * 8;
        path += `M600 ${y}h440v8H600Z`;
      }
      surface.setAttribute('d', path || empty);
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
  }
  window.addEventListener('scroll', () => {
    const now = performance.now(), y = window.scrollY;
    const delta = y - previousScroll, elapsed = now - previousTime;
    const bottom = atBottom(), arriving = bottom && !wasAtBottom;
    previousScroll = y; previousTime = now; wasAtBottom = bottom;
    if (delta <= 0 || elapsed > 160) samples = [];
    if (delta > 0) samples.push({ at: now, distance: delta, speed: delta / Math.max(16, Math.min(elapsed, 100)) });
    samples = samples.filter(sample => now - sample.at <= 120);
    // Preserve the gesture through continuous touch/trackpad momentum.
    if (delta > 0 && now - gestureAt <= 180) gestureAt = now;
    if (!bottom) { if (frame) settle(); return; }
    // Use actual page travel, not wheel deltas: overscrolling an already stationary
    // footer must never trigger a new fill. A slow arrival stays quiet as well.
    if (!arriving || now - gestureAt > 180) return;
    const travel = samples.reduce((sum, sample) => sum + sample.distance, 0);
    const speed = Math.max(0, ...samples.map(sample => sample.speed));
    samples = [];
    if (travel >= 90 && speed >= 1.2) play(Math.min(1, speed / 3));
  }, { passive: true });
  window.addEventListener('wheel', event => {
    if (!event.ctrlKey && event.deltaY > 0 && !atBottom()) gestureAt = performance.now();
  }, { passive: true });
  window.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
  window.addEventListener('touchmove', event => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined && touchY > y && !atBottom()) gestureAt = performance.now();
    touchY = y ?? null;
  }, { passive: true });
  for (const type of ['touchend', 'touchcancel']) window.addEventListener(type, () => { touchY = null; }, { passive: true });
  window.addEventListener('keydown', () => { gestureAt = -Infinity; });
  window.addEventListener('resize', () => {
    previousScroll = window.scrollY; previousTime = performance.now();
    wasAtBottom = atBottom(); samples = []; gestureAt = -Infinity;
    settle();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
  reducedMotion.addEventListener('change', settle);
  window.addEventListener('pagehide', settle);
})();

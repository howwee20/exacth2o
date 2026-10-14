// A scroll-driven scanline rise, brief hold, and broken-line retreat.
(() => {
  const logo = document.querySelector('.brand-finale');
  const surface = logo?.querySelector('.brand-water-level');
  if (!surface) return;
  const empty = 'M600 250H1040V260H600Z';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, inputFrame = 0, pending = 0, touchY = null;
  let previousScroll = window.scrollY, previousTime = performance.now();
  function atBottom() {
    const page = document.scrollingElement || document.documentElement;
    const rect = logo.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0 &&
      page.scrollHeight - window.innerHeight - window.scrollY <= 3;
  }
  function settle() {
    cancelAnimationFrame(frame); cancelAnimationFrame(inputFrame);
    frame = inputFrame = pending = 0;
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
  function input(strength) {
    if (frame || reducedMotion.matches || document.hidden || !atBottom()) return;
    pending = Math.max(pending, Math.min(1, Math.max(0, strength)));
    if (!inputFrame) inputFrame = requestAnimationFrame(() => {
      inputFrame = 0;
      const strength = pending; pending = 0;
      if (strength) play(strength);
    });
  }
  window.addEventListener('scroll', () => {
    const now = performance.now(), delta = window.scrollY - previousScroll;
    const elapsed = Math.max(16, now - previousTime);
    previousScroll = window.scrollY; previousTime = now;
    if (delta > 0) input(delta / elapsed / 2);
    else if (!atBottom()) settle();
  }, { passive: true });
  window.addEventListener('wheel', event => {
    if (event.ctrlKey || event.deltaY <= 0) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    input(event.deltaY * unit / 300);
  }, { passive: true });
  window.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
  window.addEventListener('touchmove', event => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined && touchY > y) input((touchY - y) / 100);
    touchY = y ?? null;
  }, { passive: true });
  for (const type of ['touchend', 'touchcancel']) window.addEventListener(type, () => { touchY = null; }, { passive: true });
  window.addEventListener('keydown', event => {
    const target = event.target;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
        (target instanceof Element && target.closest('input, textarea, select, button, a, summary, [contenteditable="true"]'))) return;
    if (event.key === 'ArrowDown') input(.2);
    else if (event.key === 'PageDown' || event.key === 'End' || (event.key === ' ' && !event.shiftKey)) input(.8);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
  reducedMotion.addEventListener('change', settle);
  window.addEventListener('pagehide', settle);
})();

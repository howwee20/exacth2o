// The footer fills once as it enters view, on short and long pages alike.
(() => {
  const logo = document.querySelector('.brand-finale');
  const surface = logo?.querySelector('.brand-water-level');
  if (!surface) return;
  const empty = 'M600 250H1040V260H600Z';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, visible = false;
  function atBottom() { return visible; }
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
  new IntersectionObserver(entries => {
    const next = entries[0].isIntersecting && entries[0].intersectionRatio >= .6;
    if (next && !visible) { visible = true; play(1); }
    else if (!next) { visible = false; settle(); }
  }, { threshold: .6 }).observe(logo);
  document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
  reducedMotion.addEventListener('change', settle);
  window.addEventListener('pagehide', settle);
})();

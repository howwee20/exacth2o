// Downward gestures kick color through the H2O scan lines; gravity drains it.
// There is no idle animation and no persistent filled state.
(() => {
  const logo = document.querySelector('.brand-finale');
  const surface = logo?.querySelector('.brand-water-level');
  if (!surface) return;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const empty = 'M600 250H1040V260H600Z';
  let height = 0, velocity = 0, frame = 0, previous = 0;
  let lastKick = -Infinity, lastGesture = -Infinity, lastScroll = window.scrollY;
  let touchY = null;
  function visible() {
    const r = logo.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  }
  function settle() {
    cancelAnimationFrame(frame);
    frame = 0; height = 0; velocity = 0;
    surface.setAttribute('d', empty);
  }
  function draw(now) {
    if (motion.matches || !visible() || document.hidden) { settle(); return; }
    const dt = Math.min((now - previous) / 1000, .04);
    previous = now;
    velocity -= 2.8 * dt;
    height += velocity * dt;
    if (height >= 1) { height = 1; velocity = Math.min(velocity, 0); }
    if (height <= 0) { settle(); return; }
    const y = 230 - height * 220;
    const ripple = Math.sin(now / 120) * 12 * Math.sin(Math.PI * height);
    surface.setAttribute('d', `M600 ${y} Q660 ${y-12-ripple} 710 ${y} T820 ${y} T930 ${y} T1040 ${y} V260 H600Z`);
    frame = requestAnimationFrame(draw);
  }
  function splash() {
    const now = performance.now();
    if (motion.matches || !visible() || now - lastKick < 350) return;
    lastKick = now;
    velocity = 2.1;
    if (!frame) { previous = now; frame = requestAnimationFrame(draw); }
  }
  // Wheel/touch input still splashes when the page has reached its bottom.
  window.addEventListener('wheel', event => {
    if (event.deltaY > 0) { lastGesture = performance.now(); splash(); }
  }, { passive: true });
  window.addEventListener('touchstart', event => {
    touchY = event.touches[0]?.clientY ?? null;
  }, { passive: true });
  window.addEventListener('touchmove', event => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined && touchY - y > 2) {
      lastGesture = performance.now(); splash();
    }
    touchY = y ?? null;
  }, { passive: true });
  window.addEventListener('touchend', () => { touchY = null; }, { passive: true });
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y > lastScroll && performance.now() - lastGesture > 120) splash();
    lastScroll = y;
  }, { passive: true });
  window.addEventListener('keydown', event => {
    if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) &&
        !event.target.closest('input, textarea, select, [contenteditable="true"]')) splash();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
  if (motion.addEventListener) motion.addEventListener('change', settle);
  else if (motion.addListener) motion.addListener(settle);
})();

// A landing splash: recent downward input determines its height, then it drains.
(() => {
  const logo = document.querySelector('.brand-finale');
  const surface = logo?.querySelector('.brand-water-level');
  const water = logo?.querySelector('[clip-path="url(#brand-water-fill)"]');
  if (!surface || !water) return;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const empty = 'M600 250H1040V260H600Z';
  let height = 0, velocity = 0, frame = 0, previous = 0, started = 0;
  let inputFrame = 0, pending = 0, inputAt = -Infinity;
  let lastScroll = window.scrollY, scrollAt = performance.now(), touchY = null;
  function atBottom() {
    const rect = logo.getBoundingClientRect();
    const page = document.scrollingElement || document.documentElement;
    return rect.top < window.innerHeight && rect.bottom > 0 &&
      page.scrollHeight - window.innerHeight - window.scrollY <= 3;
  }
  function settle() {
    cancelAnimationFrame(frame);
    frame = 0; height = 0; velocity = 0;
    water.style.opacity = '';
    surface.setAttribute('d', empty);
  }
  function draw(now) {
    if (document.hidden || !atBottom()) { settle(); return; }
    const dt = Math.min((now - previous) / 1000, .04);
    previous = now;
    if (motion.matches) {
      // Preserve feedback without moving the waterline for reduced-motion users.
      const t = (now - started) / 500;
      if (t >= 1) { settle(); return; }
      surface.setAttribute('d', 'M600 0H1040V260H600Z');
      water.style.opacity = String(Math.sin(Math.PI * t) * .7);
    } else {
      velocity -= 3.4 * dt;
      height += velocity * dt;
      if (height >= 1) { height = 1; velocity = Math.min(velocity, 0); }
      if (height <= 0) { settle(); return; }
      const y = 218 - height * 205;
      const ripple = Math.sin((now - started) / 110) * 10 * Math.sin(Math.PI * height);
      surface.setAttribute('d', `M600 ${y} Q660 ${y-8-ripple} 710 ${y} T820 ${y} T930 ${y} T1040 ${y} V260 H600Z`);
    }
    frame = requestAnimationFrame(draw);
  }
  function flushInput(now) {
    inputFrame = 0;
    // Keep the gesture until native scrolling lands, including coarse wheel jumps.
    if (now - inputAt > 200) { pending = 0; return; }
    if (!pending || !atBottom()) return;
    if (frame) { pending = 0; return; }
    velocity = .95 + 1.85 * Math.sqrt(Math.min(1, pending));
    pending = 0;
    previous = started = now;
    frame = requestAnimationFrame(draw);
  }
  function input(strength) {
    const now = performance.now();
    if (now - inputAt > 200) pending = 0;
    pending = Math.max(pending, Math.min(1, strength));
    inputAt = now;
    if (!inputFrame) inputFrame = requestAnimationFrame(flushInput);
  }
  window.addEventListener('wheel', event => {
    if (event.ctrlKey || event.deltaY <= 0) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    input(event.deltaY * unit / 300);
  }, { passive: true });
  window.addEventListener('touchstart', event => {
    touchY = event.touches[0]?.clientY ?? null;
  }, { passive: true });
  window.addEventListener('touchmove', event => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined && touchY > y) input((touchY - y) / 100);
    touchY = y ?? null;
  }, { passive: true });
  for (const type of ['touchend', 'touchcancel']) {
    window.addEventListener(type, () => { touchY = null; }, { passive: true });
  }
  window.addEventListener('scroll', () => {
    const now = performance.now(), y = window.scrollY;
    const distance = y - lastScroll;
    if (distance > 0) {
      const speed = distance / Math.max(16, Math.min(120, now - scrollAt)) * 1000;
      input(speed / 2500);
    }
    lastScroll = y; scrollAt = now;
  }, { passive: true });
  window.addEventListener('keydown', event => {
    const target = event.target;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
        (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]'))) return;
    if (event.key === 'ArrowDown') input(.2);
    else if (event.key === 'PageDown' || event.key === 'End' || (event.key === ' ' && !event.shiftKey)) input(.8);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
  window.addEventListener('pageshow', () => { lastScroll = window.scrollY; scrollAt = performance.now(); });
  if (motion.addEventListener) motion.addEventListener('change', settle);
  else if (motion.addListener) motion.addListener(settle);
})();

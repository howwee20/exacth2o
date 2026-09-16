// The fill follows the footer entering the viewport, and reverses on scroll up.
(() => {
  const logo = document.querySelector('.brand-finale');
  if (!logo) return;
  const footer = logo.closest('footer');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let queued = false;
  function update() {
    queued = false;
    const bounds = footer.getBoundingClientRect();
    const progress = motion.matches ? 1 : Math.max(0, Math.min(1,
      (window.innerHeight - bounds.top) / Math.max(1, bounds.height)));
    logo.style.setProperty('--brand-water-offset', `${225 * (1 - progress)}px`);
  }
  function schedule() {
    if (!queued) { queued = true; requestAnimationFrame(update); }
  }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('pageshow', schedule);
  window.addEventListener('load', schedule);
  if (motion.addEventListener) motion.addEventListener('change', schedule);
  else if (motion.addListener) motion.addListener(schedule);
  update();
})();

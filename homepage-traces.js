// A rolling view of the public demo datasets. No live controller connection.
(() => {
  const root = document.querySelector('[data-homepage-traces]');
  if (!root) return;
  const svg = root.querySelector('#homepage-trace-chart');
  const provenance = root.querySelector('[data-trace-provenance]');
  const clock = root.querySelector('[data-trace-clock]');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const ns = 'http://www.w3.org/2000/svg';
  const windowHours = 72;
  let selected, endHour, plot, paths = [], points = [];
  let inView = false, paused = motion.matches, lastFrame = 0, animation = 0, lastPaint = 0;

  function node(name, attrs = {}, text) {
    const element = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text != null) element.textContent = text;
    return element;
  }
  const dayLabel = hour => `Day ${Math.floor(hour / 24) + 1}`;
  function studyTime(hour) {
    const total = Math.floor(hour * 60);
    return `${dayLabel(hour)} · ${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  function lowerBound(value) {
    let lo = 0, hi = selected.hours.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (selected.hours[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function drawFrame() {
    if (!plot) return;
    const startHour = endHour - windowHours;
    const first = Math.max(0, lowerBound(startHour) - 1);
    let last = lowerBound(endHour);
    if (selected.hours[last] > endHour || last === selected.hours.length) last--;
    const x = hour => plot.left + (hour - startHour) / windowHours * plot.width;
    const y = value => plot.top + (selected.max - value) / (selected.max - selected.min) * plot.height;
    selected.pots.forEach((pot, i) => {
      let d = '';
      for (let index = first; index <= last; index++) d += `${index === first ? 'M' : 'L'}${x(selected.hours[index]).toFixed(2)},${y(pot.values[index]).toFixed(2)}`;
      paths[i].setAttribute('d', d);
      points[i].setAttribute('cx', x(selected.hours[last]));
      points[i].setAttribute('cy', y(pot.values[last]));
    });
    plot.ticks.replaceChildren();
    for (let hour = Math.ceil(startHour / 24) * 24; hour <= endHour; hour += 24) {
      const px = x(hour);
      plot.ticks.append(node('line', { x1: px, x2: px, y1: plot.top, y2: plot.top + plot.height, class: 'trace-grid trace-grid-vertical' }),
        node('text', { x: px, y: plot.top + plot.height + 26, 'text-anchor': 'middle', class: 'trace-axis' }, dayLabel(hour)));
    }
    clock.textContent = studyTime(selected.hours[last]);
    svg.dataset.latestHour = selected.hours[last];
  }
  function prepareChart() {
    if (!selected) return;
    const width = Math.max(280, svg.getBoundingClientRect().width);
    const height = Math.max(280, svg.getBoundingClientRect().height);
    plot = { left: 42, top: 20, width: width - 57, height: height - 60 };
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.replaceChildren();
    const defs = node('defs'), clip = node('clipPath', { id: 'homepage-trace-clip' });
    clip.append(node('rect', { x: plot.left, y: plot.top - 4, width: plot.width + 4, height: plot.height + 8 }));
    defs.append(clip); svg.append(defs);
    for (let value = selected.min; value <= selected.max; value += 5) {
      const y = plot.top + (selected.max - value) / (selected.max - selected.min) * plot.height;
      svg.append(node('line', { x1: plot.left, x2: plot.left + plot.width, y1: y, y2: y, class: 'trace-grid' }),
        node('text', { x: plot.left - 10, y: y + 4, 'text-anchor': 'end', class: 'trace-axis' }, `${value}%`));
    }
    plot.ticks = node('g'); svg.append(plot.ticks);
    const lines = node('g', { 'clip-path': 'url(#homepage-trace-clip)' });
    paths = selected.pots.map(pot => node('path', { fill: 'none', stroke: pot.color, 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-pot': pot.number }));
    points = selected.pots.map(pot => node('circle', { r: 2.8, fill: pot.color, stroke: '#fff', 'stroke-width': 1 }));
    lines.append(...paths, ...points); svg.append(lines);
    svg.setAttribute('aria-label', `${selected.name}. ${selected.pots.length} colored pot moisture traces over a rolling three-day window. Values are from the public demo.`);
    drawFrame();
  }
  function initialize(experiment) {
    selected = experiment;
    endHour = selected.initialHour;
    provenance.textContent = `${selected.pots.length} pots · ${selected.kind.toLowerCase()} · accelerated replay`;
    prepareChart(); lastFrame = 0;
  }
  function tick(now) {
    animation = 0;
    if (!selected || paused || !inView || document.hidden) { lastFrame = 0; return; }
    if (lastFrame) endHour += Math.min((now - lastFrame) / 1000, .1); // One study hour per second.
    lastFrame = now;
    if (endHour >= selected.hours.at(-1)) endHour = windowHours;
    if (now - lastPaint >= 50) { drawFrame(); lastPaint = now; }
    animation = requestAnimationFrame(tick);
  }
  function syncPlayback() {
    root.dataset.playing = String(!paused);
    lastFrame = 0;
    if (animation) cancelAnimationFrame(animation);
    animation = 0;
    if (selected && !paused && inView && !document.hidden) animation = requestAnimationFrame(tick);
  }
  let loading;
  function load() {
    if (loading) return loading;
    loading = fetch('/homepage-traces-data.json?v=20261103-simple1').then(response => {
      if (!response.ok) throw new Error('Demo readings could not be loaded.');
      return response.json();
    }).then(data => {
      initialize(data.experiment);
      root.setAttribute('aria-busy', 'false'); syncPlayback();
      new ResizeObserver(prepareChart).observe(svg);
    }).catch(() => {
      provenance.textContent = 'Explore the experiment demos on the Applications page.';
      root.setAttribute('aria-busy', 'false');
    });
    return loading;
  }
  motion.addEventListener('change', () => { paused = motion.matches; syncPlayback(); });
  document.addEventListener('visibilitychange', syncPlayback);
  new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    if (inView) load();
    syncPlayback();
  }).observe(root);
})();

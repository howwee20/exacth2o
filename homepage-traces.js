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
  let activePot = -1, sampleHour = null, locked = false, gesture = null;
  const hiddenPots = new Set();
  const readout = root.querySelector('[data-trace-readout]');
  const legend = root.querySelector('[data-trace-pots]');
  const card = root.querySelector('.home-traces-chart-card');
  const tooltip = document.createElement('div');
  tooltip.className = 'trace-tooltip'; tooltip.hidden = true;
  tooltip.setAttribute('role', 'tooltip');
  const tipPot = document.createElement('strong'), tipTime = document.createElement('span'), tipValue = document.createElement('b');
  tooltip.append(tipPot, tipTime, tipValue); card.append(tooltip);
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
    updateInspection();
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
    plot.cursor = node('line', { y1: plot.top, y2: plot.top + plot.height, stroke: '#86868b', 'stroke-dasharray': '3 4', visibility: 'hidden' });
    svg.append(plot.cursor);
    plot.marker = node('circle', { r: 5, fill: '#fff', 'stroke-width': 2, visibility: 'hidden' });
    svg.append(plot.marker);
    drawFrame();
  }
  function initialize(experiment) {
    selected = experiment;
    endHour = selected.initialHour;
    provenance.textContent = `${selected.pots.length} pots · Demo replay`;
    legend.replaceChildren(...selected.pots.map((pot, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = `Pot ${pot.number}`;
      button.style.setProperty('--trace-color', pot.color);
      button.setAttribute('aria-pressed', 'true');
      button.addEventListener('click', () => {
        if (hiddenPots.has(index)) hiddenPots.delete(index); else hiddenPots.add(index);
        if (activePot === index) { activePot = -1; sampleHour = null; locked = false; }
        updateInspection();
      });
      return button;
    }));
    prepareChart(); lastFrame = 0;
  }
  function updateInspection() {
    if (!selected || !plot) return;
    paths.forEach((path, i) => {
      path.setAttribute('visibility', hiddenPots.has(i) ? 'hidden' : 'visible');
      path.setAttribute('stroke-width', i === activePot ? '3' : '1.8');
      points[i].setAttribute('visibility', hiddenPots.has(i) ? 'hidden' : 'visible');
      legend.children[i]?.setAttribute('aria-pressed', String(!hiddenPots.has(i)));
    });
    if (activePot < 0) {
      tooltip.hidden = true;
      readout.textContent = 'Hover to inspect. Click to lock.';
      plot.marker.setAttribute('visibility', 'hidden'); plot.cursor.setAttribute('visibility', 'hidden'); return;
    }
    const index = Math.max(0, Math.min(selected.hours.length - 1, lowerBound(sampleHour ?? endHour) - 1));
    const pot = selected.pots[activePot], hour = selected.hours[index], value = pot.values[index];
    readout.textContent = locked ? 'Click to resume.' : 'Click to lock.';
    tipPot.textContent = `Pot ${pot.number}`;
    tipTime.textContent = studyTime(hour);
    tipValue.textContent = `${value.toFixed(1)}% VWC`;
    tooltip.style.setProperty('--trace-color', pot.color);
    tooltip.hidden = false;
    plot.marker.setAttribute('cx', plot.left + (hour - (endHour - windowHours)) / windowHours * plot.width);
    plot.marker.setAttribute('cy', plot.top + (selected.max - value) / (selected.max - selected.min) * plot.height);
    plot.cursor.setAttribute('x1', plot.marker.getAttribute('cx'));
    plot.cursor.setAttribute('x2', plot.marker.getAttribute('cx'));
    plot.cursor.setAttribute('visibility', hour >= endHour - windowHours && hour <= endHour ? 'visible' : 'hidden');
    plot.marker.setAttribute('stroke', pot.color);
    const chartBox = svg.getBoundingClientRect(), cardBox = card.getBoundingClientRect();
    const px = Number(plot.marker.getAttribute('cx')) + chartBox.left - cardBox.left;
    const py = Number(plot.marker.getAttribute('cy')) + chartBox.top - cardBox.top;
    const tipWidth = tooltip.offsetWidth, tipHeight = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(8, Math.min(card.clientWidth - tipWidth - 8, px + tipWidth + 16 < card.clientWidth ? px + 16 : px - tipWidth - 16))}px`;
    tooltip.style.top = `${Math.max(chartBox.top - cardBox.top, py - tipHeight - 14)}px`;
    plot.marker.setAttribute('visibility', hour >= endHour - windowHours && hour <= endHour ? 'visible' : 'hidden');
  }
  function inspect(event, keepPot = false) {
    if (!plot) return;
    const rect = svg.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const hour = endHour - windowHours + Math.max(0, Math.min(1, (x - plot.left) / plot.width)) * windowHours;
    const index = Math.max(0, Math.min(selected.hours.length - 1, lowerBound(hour)));
    if (!keepPot || activePot < 0) {
      let distance = Infinity;
      activePot = -1;
      selected.pots.forEach((pot, i) => {
        if (hiddenPots.has(i)) return;
        const py = plot.top + (selected.max - pot.values[index]) / (selected.max - selected.min) * plot.height;
        if (Math.abs(py - y) < distance) { distance = Math.abs(py - y); activePot = i; }
      });
      if (distance > 24 && !gesture) activePot = -1;
    }
    sampleHour = selected.hours[index] + .00001;
    updateInspection();
  }
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !plot) return;
    const previous = locked ? activePot : -1;
    inspect(event, locked);
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, previous, moved: false };
    svg.setPointerCapture(event.pointerId);
    svg.focus({ preventScroll: true });
    lastFrame = 0;
  });
  svg.addEventListener('pointermove', event => {
    if (gesture) {
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) gesture.moved = true;
      inspect(event, true);
    } else if (event.pointerType !== 'touch') inspect(event, locked);
  });
  function finishGesture(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (!gesture.moved && gesture.previous >= 0) { activePot = -1; sampleHour = null; }
    locked = activePot >= 0;
    gesture = null; lastFrame = 0;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    updateInspection();
  }
  svg.addEventListener('pointerup', finishGesture);
  svg.addEventListener('pointercancel', () => { gesture = null; locked = false; activePot = -1; sampleHour = null; lastFrame = 0; updateInspection(); });
  svg.addEventListener('pointerleave', () => { if (!gesture && !locked) { activePot = -1; sampleHour = null; updateInspection(); } });
  svg.addEventListener('keydown', event => {
    if (!selected || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') { activePot = -1; sampleHour = null; locked = false; }
    else {
      if (hiddenPots.size === selected.pots.length) return;
      locked = true;
      if (activePot < 0) activePot = selected.pots.findIndex((_, i) => !hiddenPots.has(i));
      if (event.key === 'ArrowUp') do { activePot = (activePot + 1) % selected.pots.length; } while (hiddenPots.has(activePot));
      if (event.key === 'ArrowDown') do { activePot = (activePot + selected.pots.length - 1) % selected.pots.length; } while (hiddenPots.has(activePot));
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') sampleHour = Math.max(endHour - windowHours, Math.min(endHour, (sampleHour ?? endHour) + (event.key === 'ArrowLeft' ? -1 : 1)));
    }
    updateInspection();
  });
  function tick(now) {
    animation = 0;
    if (!selected || paused || !inView || document.hidden) { lastFrame = 0; return; }
    if (lastFrame && !gesture && !locked) endHour += Math.min((now - lastFrame) / 1000, .1); // One study hour per second.
    lastFrame = now;
    if (endHour >= selected.hours.at(-1)) endHour = windowHours;
    if (now - lastPaint >= 50) { drawFrame(); lastPaint = now; }
    animation = requestAnimationFrame(tick);
  }
  function syncPlayback() {
    root.dataset.playing = String(!paused && !locked);
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

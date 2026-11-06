// Deterministic public illustration, entirely in the page. No controller or network access.
// The simple drying/absorption model explains control; it does not predict a crop or substrate.
(() => {
  const root = document.getElementById('one-pot');
  if (!root) return;
  const target = root.querySelector('#one-pot-target');
  const chart = root.querySelector('#one-pot-chart');
  const record = root.querySelector('#record-example');
  const result = root.querySelector('#one-pot-result');
  const comparisons = root.querySelector('#one-pot-comparisons');
  const presets = [...root.querySelectorAll('[data-one-pot-target]')];
  if (!target || !chart || !result) return;

  // The target pill: drag or arrow keys preview a new target, the adjacent check applies it to the
  // simulation, and the cross or Escape restores it. Same interaction as the portal, with no equipment.
  const make = (tag, className, attrs = {}) => { const node = document.createElement(tag); node.className = className; for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };
  const control = make('div', 'one-pot-tcontrol');
  const handle = make('button', 'one-pot-pill', { type: 'button', role: 'slider', 'aria-label': 'Demo moisture target', 'aria-valuemin': target.min, 'aria-valuemax': target.max, 'aria-orientation': 'vertical' });
  handle.title = 'Drag in 1% steps or use the arrow keys, then confirm. Simulation only.';
  const cluster = make('span', 'one-pot-tcluster'); cluster.hidden = true;
  const applyButton = make('button', 'one-pot-tbtn is-apply', { type: 'button' }); applyButton.textContent = '✓';
  const cancelButton = make('button', 'one-pot-tbtn', { type: 'button', 'aria-label': 'Cancel and keep the current target', title: 'Cancel (Esc)' }); cancelButton.textContent = '×';
  cluster.append(applyButton, cancelButton); control.append(handle, cluster);
  const band = make('div', 'one-pot-tband', { 'aria-hidden': 'true' });
  const previewLine = make('div', 'one-pot-tline', { 'aria-hidden': 'true' }); previewLine.hidden = true;
  const plotWrap = make('div', 'one-pot-plot-wrap'); chart.before(plotWrap); plotWrap.append(chart, previewLine, band, control);
  const low = Number(target.min), high = Number(target.max);
  const clampTarget = value => Math.max(low, Math.min(high, Math.round(value)));
  let preview = null, drag = null;
  const setPreview = value => { preview = value == null ? null : clampTarget(value); render(); };
  const applyPreview = () => {
    if (preview == null || preview === selectedValue) { setPreview(null); return; }
    interactionStart = selectedValue; target.value = String(preview); preview = null;
    changeTarget(); rememberPrevious(); handle.focus({ preventScroll: true });
  };
  // Every move is measured from where the gesture began, on the chart's fixed 10–50% axis.
  const startDrag = e => {
    if (e.button !== 0 || !plot) return;
    e.preventDefault(); e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* moves still arrive over the control */ }
    drag = { id: e.pointerId, y: e.clientY, value: preview ?? selectedValue, scale: plot.plotH / 40 };
    handle.classList.add('is-dragging');
  };
  const moveDrag = e => { if (drag && e.pointerId === drag.id) setPreview(drag.value + (drag.y - e.clientY) / drag.scale); };
  const endDrag = e => { if (!drag || e.pointerId !== drag.id) return; drag = null; handle.classList.remove('is-dragging'); if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); };
  for (const node of [handle, band]) {
    node.addEventListener('pointerdown', startDrag); node.addEventListener('pointermove', moveDrag);
    node.addEventListener('pointerup', endDrag); node.addEventListener('pointercancel', endDrag); node.addEventListener('lostpointercapture', endDrag);
  }
  cluster.addEventListener('pointerdown', e => e.stopPropagation());
  applyButton.addEventListener('click', applyPreview);
  cancelButton.addEventListener('click', () => { setPreview(null); handle.focus({ preventScroll: true }); });
  handle.addEventListener('keydown', e => {
    const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 };
    if (e.key in steps) { e.preventDefault(); setPreview((preview ?? selectedValue) + steps[e.key]); }
    else if (e.key === 'Enter' && preview != null) { e.preventDefault(); applyPreview(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && preview != null) setPreview(null); });

  const HOUR = 3_600_000, DAY = 24 * HOUR, STEP = HOUR / 6, DURATION = 3 * DAY;
  const references = [18, 26, 36];
  let comparing = false;
  const compareButton = root.querySelector('#one-pot-compare');
  const replayButton = root.querySelector('#one-pot-replay');
  const progressLabel = root.querySelector('#one-pot-progress');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const svgNS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs = {}, text) => {
    const node = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text != null) node.textContent = text;
    return node;
  };
  function color(value) {
    const stops = [[15, [169, 91, 28]], [27, [22, 124, 101]], [40, [49, 105, 184]]];
    const [a, b] = value <= 27 ? stops.slice(0, 2) : stops.slice(1);
    const fraction = Math.max(0, Math.min(1, (value - a[0]) / (b[0] - a[0])));
    return `rgb(${a[1].map((v, i) => Math.round(v + (b[1][i] - v) * fraction)).join(',')})`;
  }
  function simulate(targetPercent, withRecord = false) {
    let level = 36, pending = 0, lastWater = -Infinity, seed = 7, noise = 0;
    const points = [], waterings = [];
    const changeAt = DAY / 4;
    for (let t = 0; t <= DURATION; t += STEP) {
      const hour = (t / HOUR) % 24;
      const daylight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
      const stress = Math.max(0.3, Math.min(1, (level - 9) / 17));
      level -= (0.55 / 6) * (0.15 + 1.5 * daylight) * stress;
      const absorbed = pending * 0.32;
      pending -= absorbed;
      level += absorbed;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise = noise * 0.72 + (seed / 4294967296 - 0.5) * 0.14;
      const measured = level + noise;
      points.push({ t, v: measured });
      const activeTarget = withRecord && t < changeAt ? 34 : targetPercent;
      if (measured < activeTarget && t - lastWater >= HOUR && pending < 0.4) {
        pending += 3;
        lastWater = t;
        waterings.push(t);
      }
    }
    return { points, waterings };
  }
  const referenceData = new Map(references.map(value => [value, simulate(value)]));
  function geometry(svg, height, bottom = 32) {
    const width = Math.max(180, Math.round(svg.getBoundingClientRect().width || 640));
    const m = { left: 34, right: 12, top: 18, bottom };
    const plotW = width - m.left - m.right, plotH = height - m.top - m.bottom;
    const x = t => m.left + (t / DURATION) * plotW;
    const y = v => m.top + (1 - (v - 10) / 40) * plotH;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    for (const value of [10, 20, 30, 40, 50]) {
      svg.append(el('line', { x1: m.left, x2: width - m.right, y1: y(value), y2: y(value), class: 'one-pot-grid' }));
      svg.append(el('text', { x: m.left - 7, y: y(value) + 4, 'text-anchor': 'end', class: 'one-pot-axis' }, `${value}%`));
    }
    for (let day = 0; day < 3; day++) {
      if (day) svg.append(el('line', { x1: x(day * DAY), x2: x(day * DAY), y1: m.top, y2: height - bottom, class: 'one-pot-grid' }));
      svg.append(el('text', { x: x((day + 0.5) * DAY), y: height - 7, 'text-anchor': 'middle', class: 'one-pot-axis' }, `Day ${day + 1}`));
    }
    const path = points => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
    return { width, height, m, x, y, path, plotW, plotH };
  }
  function drawRecord(value, ink) {
    if (!record) return;
    const { points } = simulate(value, true);
    const g = geometry(record, 260, 60);
    const calibrationAt = 1.6 * DAY, noteAt = 1.85 * DAY;
    const calibrated = points.map(p => ({ t: p.t, v: p.v * (p.t >= calibrationAt ? 1.12 : 1) }));
    // Raw values are shown on their own explicitly labelled scale; they stay continuous
    // through calibration. Their pixel offset is presentation, not another VWC measurement.
    record.append(el('path', { d: g.path(points.map(p => ({ t: p.t, v: p.v - 3 }))), class: 'record-raw' }));
    record.append(el('path', { d: g.path(calibrated), class: 'one-pot-line', style: `stroke:${ink}` }));
    const lane = g.height - 35;
    record.append(el('line', { x1: g.m.left, x2: g.width - g.m.right, y1: lane, y2: lane, class: 'one-pot-grid' }));
    for (const [at, letter, title] of [[DAY / 4, 'T', `Target changed to ${value}% VWC`], [calibrationAt, 'C', 'Calibration updated; raw output remains continuous'], [noteAt, 'N', 'Field note added']]) {
      record.append(el('line', { x1: g.x(at), x2: g.x(at), y1: g.m.top, y2: lane - 9, class: 'record-marker' }));
      const dot = el('circle', { cx: g.x(at), cy: lane, r: 9, class: `record-dot is-${letter}` });
      dot.append(el('title', {}, title));
      record.append(dot, el('text', { x: g.x(at), y: lane + 4, 'text-anchor': 'middle', class: 'record-letter' }, letter));
    }
    record.setAttribute('aria-label', `Moisture response: target changes from 34% to ${value}% VWC; calibrated moisture changes at C while raw output remains continuous; field note at N.`);
    root.querySelector('#record-target-event').textContent = `Target → ${value}% VWC`;
  }

  const dryDown = simulate(0);
  let selectedValue = Number(target.value);
  let currentValue = selectedValue;
  let selected = simulate(selectedValue);
  let currentPoints = selected.points.map(p => ({ ...p }));
  let plot, frame = 0, morph = null, replayStarted = null, replayProgress = 1;
  let previousTarget = null;
  let interactionStart = selectedValue;
  let inputFrame = 0;
  const mean = data => data.points.reduce((sum, p) => sum + p.v, 0) / data.points.length;
  const longestInterval = data => {
    const times = [0, ...data.waterings, DURATION];
    return Math.max(...times.slice(1).map((t, i) => t - times[i])) / HOUR;
  };
  const ease = t => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

  function preparePlot() {
    const height = Math.max(280, Math.round(chart.getBoundingClientRect().height || 360));
    const g = geometry(chart, height, 36);
    const defs = el('defs');
    const clip = el('clipPath', { id: 'one-pot-plot-clip' });
    const clipRect = el('rect', { x: g.m.left, y: g.m.top, width: g.plotW, height: g.plotH });
    clip.append(clipRect); defs.append(clip); chart.append(defs);
    const group = el('g', { 'clip-path': 'url(#one-pot-plot-clip)' });
    const baseline = el('path', { d: g.path(dryDown.points), class: 'one-pot-dry', 'data-trace': 'unwatered' });
    baseline.append(el('title', {}, 'Without irrigation: the same illustrative pot dries over three days.'));
    const comparisonGroup = el('g', { class: 'one-pot-comparison-traces' });
    const previous = el('path', { class: 'one-pot-previous', 'data-trace': 'previous' });
    const area = el('path', { class: 'one-pot-area' });
    const targetLine = el('line', { x1: g.m.left, x2: g.width - g.m.right, class: 'one-pot-target' });
    const openings = el('g', { class: 'one-pot-waterings' });
    const line = el('path', { class: 'one-pot-line one-pot-selected', 'data-trace': 'selected' });
    const playhead = el('line', { y1: g.m.top, y2: g.m.top + g.plotH, class: 'one-pot-playhead' });
    const point = el('circle', { r: 5, class: 'one-pot-live-point' });
    group.append(area, baseline, comparisonGroup, previous, targetLine, openings, line, playhead, point);
    const label = el('text', { x: g.width - g.m.right - 4, 'text-anchor': 'end', class: 'one-pot-target-label' });
    chart.append(group, label);
    plot = { ...g, clipRect, comparisonGroup, previous, area, targetLine, openings, line, label, point, playhead };
    drawComparisons(false);
    drawOpenings(false);
    render();
  }

  function drawComparisons(animate) {
    if (!plot) return;
    plot.comparisonGroup.replaceChildren();
    if (comparing) {
      references.forEach((value, index) => {
        const trace = el('path', {
          d: plot.path(referenceData.get(value).points),
          class: `one-pot-comparison${animate && !reducedMotion.matches ? ' is-entering' : ''}`,
          pathLength: 1000,
          'data-trace': `reference-${value}`,
          style: `stroke:${color(value)};--trace-delay:${index * 90}ms`,
        });
        trace.append(el('title', {}, `${value}% target: ${referenceData.get(value).waterings.length} simulated valve openings.`));
        plot.comparisonGroup.append(trace);
      });
    }
    plot.previous.hidden = previousTarget == null;
    plot.previous.setAttribute('opacity', previousTarget == null ? '0' : '.55');
    if (previousTarget != null) {
      plot.previous.setAttribute('d', plot.path(simulate(previousTarget).points));
      plot.previous.style.stroke = color(previousTarget);
    }
    if (comparisons) {
      comparisons.hidden = !comparing && previousTarget == null;
      comparisons.replaceChildren();
      if (comparing) for (const value of references) {
        const chip = document.createElement('span');
        chip.style.setProperty('--comparison-color', color(value));
        chip.textContent = `${value}% target`;
        comparisons.append(chip);
      }
      if (previousTarget != null) {
        const chip = document.createElement('span');
        chip.className = 'is-previous';
        chip.style.setProperty('--comparison-color', color(previousTarget));
        chip.textContent = `Previous · ${previousTarget}%`;
        comparisons.append(chip);
      }
      const active = document.createElement('strong');
      active.textContent = `Your target · ${selectedValue}%`;
      comparisons.append(active);
    }
    compareButton?.setAttribute('aria-pressed', String(comparing));
  }

  function drawOpenings(animate) {
    if (!plot) return;
    plot.openings.replaceChildren();
    for (const at of selected.waterings) {
      const group = el('g', { 'data-at': at, class: animate && !reducedMotion.matches ? 'one-pot-water-event is-new' : 'one-pot-water-event' });
      const x = plot.x(at);
      group.append(el('rect', { x: x - 2, y: plot.m.top, width: 4, height: plot.plotH, class: 'one-pot-water-shade' }));
      group.append(el('line', { x1: x, x2: x, y1: plot.height - plot.m.bottom - 10, y2: plot.height - plot.m.bottom, class: 'one-pot-tick' }));
      const dot = el('circle', { cx: x, r: 3.3, class: 'one-pot-opening' });
      dot.append(el('title', {}, `Valve opening at ${(at / HOUR).toFixed(1)} hours`));
      group.append(dot); plot.openings.append(group);
    }
  }

  function updateSummary() {
    const ink = color(selectedValue);
    root.style.setProperty('--target-color', ink);
    target.style.setProperty('--target-position', `${(selectedValue - 15) / 25 * 100}%`);
    root.querySelector('#one-pot-target-value').textContent = `${selectedValue}%`;
    target.setAttribute('aria-valuetext', `${selectedValue}% volumetric water content; illustrative simulation`);
    const count = selected.waterings.length;
    root.querySelector('#one-pot-openings').textContent = count;
    root.querySelector('#one-pot-mean').textContent = `${mean(selected).toFixed(1)}%`;
    root.querySelector('#one-pot-interval').textContent = `${longestInterval(selected).toFixed(1)} h`;
    const direction = selectedValue <= 20 ? 'Longer intervals between watering.' : selectedValue <= 30 ? '' : 'More frequent watering.';
    result.textContent = `${count} valve ${count === 1 ? 'opening' : 'openings'} · 3 days. ${direction}`.trim();
    chart.setAttribute('aria-label', `Illustrative moisture simulation: ${selectedValue}% target over three days, with ${count} simulated valve ${count === 1 ? "opening" : "openings"}. Mean ${mean(selected).toFixed(1)}% VWC. Dashed gray is the same pot without irrigation.${comparing ? ' Compare the 18%, 26%, and 36% target lines.' : ''}${previousTarget != null ? ` The dotted line is your previous ${previousTarget}% target.` : ''}`);
    for (const button of presets) {
      const value = Number(button.dataset.onePotTarget);
      button.style.setProperty('--preset-color', color(value));
      button.setAttribute('aria-pressed', String(value === selectedValue));
    }
    drawRecord(selectedValue, ink);
  }

  function render() {
    if (!plot) return;
    const { path, x, y, m, plotW, plotH } = plot;
    const ink = color(currentValue);
    plot.line.setAttribute('d', path(currentPoints));
    plot.line.style.stroke = ink;
    plot.area.setAttribute('d', `${path(currentPoints)}L${x(DURATION)} ${m.top + plotH}L${x(0)} ${m.top + plotH}Z`);
    plot.area.style.fill = ink;
    plot.targetLine.setAttribute('y1', y(selectedValue));
    plot.targetLine.setAttribute('y2', y(selectedValue));
    plot.targetLine.style.stroke = ink;
    plot.label.setAttribute('y', Math.max(m.top + 12, y(currentValue) - 8));
    plot.label.style.fill = ink;
    plot.label.textContent = '';
    const shown = preview ?? selectedValue, changed = preview != null && preview !== selectedValue;
    handle.textContent = `${shown}% target`;
    handle.classList.toggle('is-preview', changed);
    handle.setAttribute('aria-valuenow', String(shown));
    handle.setAttribute('aria-valuetext', `${shown}% target${changed ? ', not applied' : ''}; simulation only`);
    control.style.top = band.style.top = `${y(shown)}px`;
    control.style.left = `${m.left + 8}px`;
    band.style.left = previewLine.style.left = `${m.left}px`;
    band.style.width = previewLine.style.width = `${plotW}px`;
    previewLine.style.top = `${y(shown)}px`;
    previewLine.hidden = cluster.hidden = !changed;
    applyButton.setAttribute('aria-label', `Apply ${shown}% target to the simulation`); applyButton.title = applyButton.getAttribute('aria-label');
    const replaying = replayStarted != null;
    plot.clipRect.setAttribute('width', plotW * (replaying ? replayProgress : 1));
    plot.playhead.setAttribute('opacity', replaying ? '1' : '0');
    plot.point.setAttribute('opacity', replaying ? '1' : '0');
    if (replaying) {
      const index = Math.min(currentPoints.length - 1, Math.floor(replayProgress * (currentPoints.length - 1)));
      const p = currentPoints[index];
      plot.point.setAttribute('cx', x(p.t)); plot.point.setAttribute('cy', y(p.v));
      plot.playhead.setAttribute('x1', x(p.t)); plot.playhead.setAttribute('x2', x(p.t));
      if (progressLabel) progressLabel.textContent = `${(p.t / HOUR).toFixed(0)} of 72 hours`;
    } else if (progressLabel) progressLabel.textContent = 'Three days';
    for (const group of plot.openings.children) {
      const at = Number(group.dataset.at);
      const p = currentPoints[Math.round(at / STEP)];
      group.querySelector('circle').setAttribute('cy', y(p.v));
    }
  }

  function tick(now) {
    frame = 0;
    if (morph) {
      const t = ease((now - morph.started) / 320);
      currentValue = morph.fromValue + (selectedValue - morph.fromValue) * t;
      currentPoints = selected.points.map((p, i) => ({ t: p.t, v: morph.from[i].v + (p.v - morph.from[i].v) * t }));
      if (t >= 1) morph = null;
    }
    if (replayStarted != null) {
      replayProgress = Math.min(1, (now - replayStarted) / 4200);
      if (replayProgress >= 1) {
        replayStarted = null;
        replayButton.textContent = 'Replay 3 days';
        replayButton.setAttribute('aria-pressed', 'false');
      }
    }
    render();
    if (morph || replayStarted != null) frame = requestAnimationFrame(tick);
  }
  const animate = () => { if (!frame) frame = requestAnimationFrame(tick); };
  function stopReplay() {
    replayStarted = null; replayProgress = 1;
    if (replayButton) { replayButton.textContent = 'Replay 3 days'; replayButton.setAttribute('aria-pressed', 'false'); }
  }
  function changeTarget() {
    inputFrame = 0;
    const next = Number(target.value);
    preview = null;
    if (next === selectedValue) { render(); return; }
    stopReplay();
    const newlyComparing = !comparing;
    comparing = true;
    selectedValue = next;
    selected = simulate(next);
    morph = { from: currentPoints.map(p => ({ ...p })), fromValue: currentValue, started: performance.now() };
    if (reducedMotion.matches) { currentValue = next; currentPoints = selected.points; morph = null; }
    drawComparisons(newlyComparing);
    drawOpenings(true);
    updateSummary();
    render(); animate();
  }
  function rememberPrevious() {
    if (Math.abs(interactionStart - selectedValue) >= 2) {
      previousTarget = interactionStart;
      drawComparisons(true);
      updateSummary();
    }
    interactionStart = selectedValue;
  }
  target.addEventListener('pointerdown', () => { interactionStart = selectedValue; });
  target.addEventListener('input', () => { if (!inputFrame) inputFrame = requestAnimationFrame(changeTarget); });
  target.addEventListener('change', () => { if (inputFrame) { cancelAnimationFrame(inputFrame); inputFrame = 0; changeTarget(); } rememberPrevious(); });
  for (const button of presets) button.addEventListener('click', () => {
    interactionStart = selectedValue;
    target.value = button.dataset.onePotTarget;
    changeTarget(); rememberPrevious();
  });
  compareButton?.addEventListener('click', () => { comparing = !comparing; if (!comparing) previousTarget = null; drawComparisons(comparing); updateSummary(); });
  function startReplay() {
    currentValue = selectedValue; currentPoints = selected.points; morph = null;
    if (reducedMotion.matches) { render(); return; }
    replayStarted = performance.now(); replayProgress = 0;
    replayButton.textContent = 'Show full window'; replayButton.setAttribute('aria-pressed', 'true');
    render(); animate();
  }
  replayButton?.addEventListener('click', () => {
    if (replayStarted != null) { stopReplay(); render(); return; }
    startReplay();
  });
  // The three days play once as the chart first comes into view.
  if (replayButton && 'IntersectionObserver' in window) {
    const intro = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      intro.disconnect();
      if (!reducedMotion.matches && !document.hidden && replayStarted == null && !morph) startReplay();
    }, { threshold: 0.45 });
    intro.observe(chart);
  }
  if (typeof ResizeObserver !== 'undefined') {
    let width = 0, height = 0;
    const observer = new ResizeObserver(() => {
      const rect = chart.getBoundingClientRect();
      if (Math.abs(rect.width - width) > 1 || Math.abs(rect.height - height) > 1) {
        width = rect.width; height = rect.height;
        preparePlot(); drawRecord(selectedValue, color(selectedValue));
      }
    });
    observer.observe(chart);
  }
  reducedMotion.addEventListener('change', () => {
    if (!reducedMotion.matches) return;
    stopReplay(); morph = null; currentPoints = selected.points; currentValue = selectedValue;
    render();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopReplay(); render(); } });
  preparePlot(); updateSummary();
})();

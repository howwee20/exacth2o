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

  const HOUR = 3_600_000, DAY = 24 * HOUR, STEP = HOUR / 6, DURATION = 3 * DAY;
  const references = [18, 26, 36];
  let comparing = false, scheduled = 0;
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
    const width = Math.max(260, Math.round(svg.getBoundingClientRect().width || 640));
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
    record.setAttribute('aria-label', `Simulated record: target changes from 34% to ${value}% VWC; calibrated moisture changes at C while raw output remains continuous; field note at N.`);
    root.querySelector('#record-target-event').textContent = `Target → ${value}% VWC`;
  }
  function draw() {
    scheduled = 0;
    const value = Number(target.value), ink = color(value);
    const { points, waterings } = simulate(value);
    const g = geometry(chart, 290);
    root.style.setProperty('--target-color', ink);
    target.style.setProperty('--target-position', `${(value - 15) / 25 * 100}%`);
    chart.append(el('rect', { x: g.m.left, y: g.y(value), width: g.plotW, height: g.height - g.m.bottom - g.y(value), fill: ink, opacity: '.045' }));
    if (comparing) {
      for (const reference of references.filter(v => v !== value)) {
        const trace = el('path', { d: g.path(referenceData.get(reference).points), class: 'one-pot-comparison', style: `stroke:${color(reference)}` });
        trace.append(el('title', {}, `${reference}% target`));
        chart.append(trace);
      }
    }
    chart.append(el('line', { x1: g.m.left, x2: g.width - g.m.right, y1: g.y(value), y2: g.y(value), class: 'one-pot-target', style: `stroke:${ink}` }));
    chart.append(el('text', { x: g.width - g.m.right - 3, y: g.y(value) - 7, 'text-anchor': 'end', class: 'one-pot-target-label', style: `fill:${ink}` }, `${value}% target`));
    chart.append(el('path', { d: g.path(points), class: 'one-pot-line' }));
    for (const at of waterings) {
      chart.append(el('line', { x1: g.x(at), x2: g.x(at), y1: g.height - g.m.bottom - 9, y2: g.height - g.m.bottom, class: 'one-pot-tick' }));
      const point = points[Math.round(at / STEP)];
      const dot = el('circle', { cx: g.x(at), cy: g.y(point.v), r: 2.4, class: 'one-pot-opening' });
      dot.append(el('title', {}, `Valve opening at ${(at / HOUR).toFixed(1)} hours`));
      chart.append(dot);
    }
    if (comparisons) {
      comparisons.hidden = !comparing;
      comparisons.replaceChildren();
      for (const reference of references.filter(v => v !== value)) {
        const chip = document.createElement('span');
        chip.style.setProperty('--comparison-color', color(reference));
        chip.textContent = `${reference}%`;
        comparisons.append(chip);
      }
      const selected = document.createElement('strong');
      selected.textContent = `Your target · ${value}%`;
      comparisons.append(selected);
    }
    const count = waterings.length;
    result.textContent = `${count} valve ${count === 1 ? 'opening' : 'openings'} · 3 days`;
    root.querySelector('#one-pot-target-value').textContent = `${value}%`;
    target.setAttribute('aria-valuetext', `${value}% volumetric water content`);
    chart.setAttribute('aria-label', `Simulated moisture at a ${value}% target with ${count} valve openings over three days.${comparing ? ' Thin lines compare 18%, 26%, and 36% targets; the bold line is your selected target.' : ''}`);
    for (const button of presets) {
      const preset = Number(button.dataset.onePotTarget);
      button.style.setProperty('--preset-color', color(preset));
      button.setAttribute('aria-pressed', String(preset === value));
    }
    drawRecord(value, ink);
  }
  const update = () => { if (!scheduled) scheduled = requestAnimationFrame(draw); };
  target.addEventListener('input', () => { comparing = true; update(); });
  for (const button of presets) button.addEventListener('click', () => {
    target.value = button.dataset.onePotTarget;
    comparing = true;
    update();
  });
  if (typeof ResizeObserver !== 'undefined') {
    const widths = new WeakMap();
    const observer = new ResizeObserver(entries => {
      for (const { target: observed, contentRect } of entries) {
        const width = Math.round(contentRect.width);
        if (Math.abs(width - (widths.get(observed) || 0)) > 4) {
          widths.set(observed, width);
          update();
        }
      }
    });
    observer.observe(chart);
    if (record) observer.observe(record);
  }
  draw();
})();

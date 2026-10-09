// "One pot, your target" — the public explainer of the controller's watering rule.
//
// A synthetic, deterministic illustration that runs entirely in the page: no network request,
// no portal session and no connection to any controller. The response model (drying driven by a
// daily light cycle, a pulse of water soaking in over a few readings) is deliberately simple; it
// explains the rule, it does not predict any substrate, emitter or crop.
(() => {
  const root = document.getElementById("one-pot");
  if (!root) return;

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const STEP = 10 * MIN;
  const DAYS = 3;

  const target = root.querySelector("#one-pot-target");
  const targetValue = root.querySelector("#one-pot-target-value");
  const chart = root.querySelector("#one-pot-chart");
  const result = root.querySelector("#one-pot-result");
  const presets = root.querySelectorAll("[data-one-pot-target]");
  if (!target || !chart || !result) return;

  /** Moisture of one synthetic pot over three days under the rule "water when below target". */
  function simulate(targetPercent) {
    let level = 36;
    let pending = 0;
    let lastWater = -Infinity;
    let seed = 7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let noise = 0;
    const points = [];
    const waterings = [];
    for (let t = 0; t <= DAYS * DAY; t += STEP) {
      const hour = (t / HOUR) % 24;
      const daylight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
      const stress = Math.max(0.3, Math.min(1, (level - 9) / 17));
      level -= (0.55 / 6) * (0.15 + 1.5 * daylight) * stress;
      const absorbed = pending * 0.32;
      pending -= absorbed;
      level += absorbed;
      noise = noise * 0.72 + (random() - 0.5) * 0.14;
      const measured = level + noise;
      points.push({ t, v: measured });
      // The controller rule: a reading below the target opens the valve once; it then waits
      // for the water to soak in before it can open again.
      if (measured < targetPercent && t - lastWater >= HOUR && pending < 0.4) {
        pending += 3;
        lastWater = t;
        waterings.push(t);
      }
    }
    return { points, waterings };
  }

  const svgNS = "http://www.w3.org/2000/svg";
  const el = (name, attrs = {}, text) => {
    const node = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text != null) node.textContent = text;
    return node;
  };

  function draw(targetPercent) {
    const { points, waterings } = simulate(targetPercent);
    // Drawn at the element's real width so labels stay legible on a phone.
    const width = Math.max(300, Math.round(chart.getBoundingClientRect().width || 720));
    const height = width < 520 ? 230 : 260;
    const m = { left: 40, right: 16, top: 14, bottom: 34 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const yMin = 10;
    const yMax = 45;
    const x = (t) => m.left + (t / (DAYS * DAY)) * plotW;
    const y = (v) => m.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    chart.replaceChildren();
    chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    for (const value of [10, 20, 30, 40]) {
      chart.append(el("line", { x1: m.left, x2: m.left + plotW, y1: y(value), y2: y(value), class: "one-pot-grid" }));
      chart.append(el("text", { x: m.left - 8, y: y(value) + 4, "text-anchor": "end", class: "one-pot-axis" }, `${value}%`));
    }
    for (let day = 0; day <= DAYS; day += 1) {
      chart.append(el("line", { x1: x(day * DAY), x2: x(day * DAY), y1: m.top, y2: m.top + plotH, class: "one-pot-grid" }));
      if (day < DAYS) chart.append(el("text", { x: x(day * DAY + DAY / 2), y: height - 10, "text-anchor": "middle", class: "one-pot-axis" }, `Day ${day + 1}`));
    }
    // Watering events: one short tick per valve opening, along the bottom.
    for (const at of waterings) {
      chart.append(el("line", { x1: x(at), x2: x(at), y1: m.top + plotH - 10, y2: m.top + plotH, class: "one-pot-tick" }));
    }
    // The target hairline.
    chart.append(el("line", { x1: m.left, x2: m.left + plotW, y1: y(targetPercent), y2: y(targetPercent), class: "one-pot-target" }));
    chart.append(el("text", { x: m.left + plotW - 4, y: y(targetPercent) - 6, "text-anchor": "end", class: "one-pot-target-label" }, `Target ${targetPercent}%`));
    // The pot's measured moisture.
    const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join("");
    chart.append(el("path", { d, class: "one-pot-line" }));

    const count = waterings.length;
    chart.setAttribute("aria-label", `A synthetic pot over three days with a ${targetPercent}% target. The valve opened ${count} ${count === 1 ? "time" : "times"}.`);
    result.textContent = `Simulation: ${count} valve ${count === 1 ? "opening" : "openings"} over three days at a ${targetPercent}% target.`;
    if (targetValue) targetValue.textContent = `${targetPercent}%`;
  }

  const update = () => draw(Number(target.value));
  target.addEventListener("input", update);
  if (typeof ResizeObserver !== "undefined") {
    let lastWidth = 0;
    new ResizeObserver(() => {
      const next = Math.round(chart.getBoundingClientRect().width);
      if (Math.abs(next - lastWidth) > 8) {
        lastWidth = next;
        update();
      }
    }).observe(chart);
  }
  for (const button of presets) {
    button.addEventListener("click", () => {
      target.value = button.getAttribute("data-one-pot-target");
      update();
    });
  }
  update();
})();

// "Every experiment keeps its record" — a concise synthetic example: the calibrated reading of
// one pot steps up when a new calibration is applied, while the raw sensor output is continuous.
(() => {
  const svg = document.getElementById("record-example");
  if (!svg) return;
  const svgNS = "http://www.w3.org/2000/svg";
  const el = (name, attrs = {}, text) => {
    const node = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text != null) node.textContent = text;
    return node;
  };
  const drawRecord = () => {
  svg.replaceChildren();
  const width = Math.max(300, Math.round(svg.getBoundingClientRect().width || 720));
  const height = 210;
  const m = { left: 40, right: 16, top: 12, bottom: 46 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  // Two and a half days around the events; one reading every 10 minutes.
  const steps = Math.round(2.5 * 144);
  const targetChangeAt = Math.round(0.25 * 144);
  // Mid-way between two waterings, so the step cannot be mistaken for one.
  const calibrationAt = 231;
  const x = (i) => m.left + (i / steps) * plotW;
  const y = (v) => m.top + (1 - (v - 18) / (36 - 18)) * plotH;
  const calibrated = [];
  const raw = [];
  for (let i = 0; i <= steps; i += 1) {
    const hours = i / 6;
    const target = i < targetChangeAt ? 34 : 22;
    const drying = i < targetChangeAt ? 0 : Math.max(0, 34 - 0.4 * (hours - targetChangeAt / 6));
    const saw = target + 2.6 * (1 - ((hours / 7) % 1));
    const truth = Math.max(saw, drying);
    calibrated.push(i >= calibrationAt ? truth * 1.12 : truth);
    raw.push(truth);
  }
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  for (const value of [20, 25, 30, 35]) {
    svg.append(el("line", { x1: m.left, x2: m.left + plotW, y1: y(value), y2: y(value), class: "one-pot-grid" }));
    svg.append(el("text", { x: m.left - 8, y: y(value) + 4, "text-anchor": "end", class: "one-pot-axis" }, `${value}%`));
  }
  const path = (values, offset = 0) => values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${(y(v) + offset).toFixed(1)}`).join("");
  // Raw output has its own units; it is drawn on its own scale, shifted below, to show continuity.
  svg.append(el("path", { d: path(raw, 18), class: "record-raw" }));
  svg.append(el("path", { d: path(calibrated), class: "one-pot-line" }));
  const lane = m.top + plotH + 22;
  svg.append(el("line", { x1: m.left, x2: m.left + plotW, y1: lane, y2: lane, class: "one-pot-grid" }));
  for (const [i, letter] of [[targetChangeAt, "R"], [calibrationAt, "C"], [calibrationAt + 30, "N"]]) {
    svg.append(el("line", { x1: x(i), x2: x(i), y1: m.top, y2: lane - 9, class: "record-marker" }));
    svg.append(el("circle", { cx: x(i), cy: lane, r: 9, class: `record-dot is-${letter}` }));
    svg.append(el("text", { x: x(i), y: lane + 4, "text-anchor": "middle", class: "record-letter" }, letter));
  }
  };
  drawRecord();
  if (typeof ResizeObserver !== "undefined") {
    let lastWidth = 0;
    new ResizeObserver(() => {
      const next = Math.round(svg.getBoundingClientRect().width);
      if (Math.abs(next - lastWidth) > 8) {
        lastWidth = next;
        drawRecord();
      }
    }).observe(svg);
  }
})();

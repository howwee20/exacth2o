const els = {
  refreshButton: document.getElementById("refreshButton"),
  timestamp: document.getElementById("timestamp"),
  summary: document.getElementById("summary"),
  summaryBadge: document.getElementById("summaryBadge"),
  overallTitle: document.getElementById("overallTitle"),
  overallDetail: document.getElementById("overallDetail"),
  systemTile: document.getElementById("systemTile"),
  systemTileValue: document.getElementById("systemTileValue"),
  systemTileDetail: document.getElementById("systemTileDetail"),
  networkTile: document.getElementById("networkTile"),
  networkTileValue: document.getElementById("networkTileValue"),
  networkTileDetail: document.getElementById("networkTileDetail"),
  hardwareTile: document.getElementById("hardwareTile"),
  hardwareTileValue: document.getElementById("hardwareTileValue"),
  hardwareTileDetail: document.getElementById("hardwareTileDetail"),
  mapTile: document.getElementById("mapTile"),
  mapTileValue: document.getElementById("mapTileValue"),
  mapTileDetail: document.getElementById("mapTileDetail"),
  restartBadge: document.getElementById("restartBadge"),
  restartDetail: document.getElementById("restartDetail"),
  restartFacts: document.getElementById("restartFacts"),
  restartGraph: document.getElementById("restartGraph"),
  restartEventLog: document.getElementById("restartEventLog"),
  mattMapBadge: document.getElementById("mattMapBadge"),
  mattMapDetail: document.getElementById("mattMapDetail"),
  potMap: document.getElementById("potMap"),
  mattSensorTable: document.getElementById("mattSensorTable"),
  ethernetGraph: document.getElementById("ethernetGraph"),
  ethernetGraphBadge: document.getElementById("ethernetGraphBadge"),
  ethernetGraphDetail: document.getElementById("ethernetGraphDetail"),
  powerGraph: document.getElementById("powerGraph"),
  powerGraphBadge: document.getElementById("powerGraphBadge"),
  powerGraphDetail: document.getElementById("powerGraphDetail"),
  powerFacts: document.getElementById("powerFacts"),
  connectivityFacts: document.getElementById("connectivityFacts"),
  schedulerGraph: document.getElementById("schedulerGraph"),
  schedulerGraphBadge: document.getElementById("schedulerGraphBadge"),
  schedulerGraphDetail: document.getElementById("schedulerGraphDetail"),
  schedulerFacts: document.getElementById("schedulerFacts"),
  sensorGraph: document.getElementById("sensorGraph"),
  sensorGraphBadge: document.getElementById("sensorGraphBadge"),
  sensorGraphDetail: document.getElementById("sensorGraphDetail"),
  sensorFacts: document.getElementById("sensorFacts"),
  waterGraph: document.getElementById("waterGraph"),
  waterGraphBadge: document.getElementById("waterGraphBadge"),
  waterGraphDetail: document.getElementById("waterGraphDetail"),
  waterFacts: document.getElementById("waterFacts"),
  apiBadge: document.getElementById("apiBadge"),
  apiFacts: document.getElementById("apiFacts"),
  networkBadge: document.getElementById("networkBadge"),
  networkFacts: document.getElementById("networkFacts"),
  piBadge: document.getElementById("piBadge"),
  piFacts: document.getElementById("piFacts"),
  boardsBadge: document.getElementById("boardsBadge"),
  boardRow: document.getElementById("boardRow"),
  detailOverlay: document.getElementById("detailOverlay"),
  detailDrawer: document.getElementById("detailDrawer"),
  detailClose: document.getElementById("detailClose"),
  detailTitle: document.getElementById("detailTitle"),
  detailBody: document.getElementById("detailBody"),
};

const HISTORY_DAYS = 21;
const LIVE_SAMPLE_LIMIT = 150;
const DEFAULT_SENSOR_STALE_MINUTES = 120;
const GRAPH_WINDOW_PRESETS = [
  { label: "8h", hours: 8 },
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
  { label: "21d", hours: 504 },
];
const PUBLIC_BASE_PATH = window.location.pathname.startsWith("/owner-health") ? "/owner-health" : "";
const API_ORIGIN = window.location.protocol === "file:" ? "http://127.0.0.1:8767" : PUBLIC_BASE_PATH;

let liveSamples = [];
let persistedHistory = [];
let graphWindowPresetIndex = 0;
let lastDashboardData = null;

const labels = {
  ok: "OK",
  warning: "Watch",
  critical: "Action",
  pending: "Checking",
  neutral: "Info",
};

const ownerStatusLabels = {
  OK: "OK",
  WATCH: "Watch",
  DEGRADED: "Degraded",
  DOWN: "Down",
  UNKNOWN: "Unknown",
};

function getOwnerStatus(data) {
  return (data && (data.ownerStatus || data.owner_status)) || {};
}

function statusLabel(status) {
  return ownerStatusLabels[String(status || "").toUpperCase()] || "Unknown";
}

function levelFromOwnerStatus(status) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "OK") return "ok";
  if (normalized === "DOWN") return "critical";
  if (normalized === "WATCH" || normalized === "DEGRADED") return "warning";
  return "neutral";
}

function apiPath(path) {
  return `${API_ORIGIN}${path}`;
}

function text(value) {
  if (value === null || value === undefined || value === "") return "--";
  return String(value);
}

function escapeHtml(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function detailAttribute(title, rows, level = "neutral") {
  return escapeHtml(JSON.stringify({ title, rows, level }));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value) {
  const ms = new Date(value || "").getTime();
  return Number.isFinite(ms) ? ms : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function shortTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function dateTimeText(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function chartTimeLabel(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
}

function ageMinutes(value) {
  const ms = timestampMs(value);
  if (ms === null) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 60000));
}

function ageText(value) {
  const minutes = ageMinutes(value);
  if (minutes === null) return "--";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m ago` : `${hours}h ago`;
}

function durationText(ms) {
  const seconds = finiteNumber(ms) === null ? null : Math.max(0, Math.round(ms / 1000));
  if (seconds === null) return "--";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) return remainderSeconds ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

function historyRangeText(records) {
  if (!records.length) return "No 21-day samples yet";
  const first = records[0].t;
  const last = records[records.length - 1].t;
  if (!first || !last || first === last) return `${records.length} sample${records.length === 1 ? "" : "s"}`;
  return `${records.length} samples, ${chartTimeLabel(first)} to ${chartTimeLabel(last)}`;
}

function graphWindowPreset() {
  return GRAPH_WINDOW_PRESETS[graphWindowPresetIndex] || GRAPH_WINDOW_PRESETS[0];
}

function graphRecordTimes(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => timestampMs(record && record.t))
    .filter((value) => value !== null);
}

function graphVisibleRange(records) {
  const times = graphRecordTimes(records);
  if (!times.length) return null;
  const preset = graphWindowPreset();
  const earliest = Math.min(...times);
  const latest = Math.max(...times);
  const windowMs = preset.hours * 60 * 60 * 1000;
  const min = Math.max(earliest, latest - windowMs);
  return {
    min,
    max: latest,
    earliest,
    latest,
    preset,
    canExpand: graphWindowPresetIndex < GRAPH_WINDOW_PRESETS.length - 1 && min > earliest,
    canContract: graphWindowPresetIndex > 0,
    isDefault: graphWindowPresetIndex === 0,
  };
}

function filterRecordsForGraphWindow(records) {
  const range = graphVisibleRange(records);
  if (!range) return Array.isArray(records) ? records : [];
  return records.filter((record) => {
    const ms = timestampMs(record && record.t);
    return ms !== null && ms >= range.min && ms <= range.max;
  });
}

function filterEventsForGraphWindow(events, range) {
  if (!range) return Array.isArray(events) ? events : [];
  return (Array.isArray(events) ? events : []).filter((event) => {
    const ms = timestampMs(event && event.t);
    return ms !== null && ms >= range.min && ms <= range.max;
  });
}

function renderGraphControls(records) {
  const range = graphVisibleRange(records);
  const expandDisabled = !range || !range.canExpand ? " disabled" : "";
  const contractDisabled = !range || !range.canContract ? " disabled" : "";
  const resetDisabled = !range || range.isDefault ? " disabled" : "";
  return `<div class="graph-controls" aria-label="Graph history controls">
    <div class="graph-window-buttons">
      <button class="graph-window-button" type="button" data-graph-window-action="expand" title="Show older history" aria-label="Show older history"${expandDisabled}>&larr;</button>
      <button class="graph-window-button" type="button" data-graph-window-action="contract" title="Show less history" aria-label="Show less history"${contractDisabled}>&rarr;</button>
      <button class="graph-window-reset" type="button" data-graph-window-action="reset"${resetDisabled}>Reset</button>
    </div>
  </div>`;
}

function formatNumber(value, unit = "") {
  const number = finiteNumber(value);
  if (number === null) return "--";
  const precision = Math.abs(number) >= 10 || Number.isInteger(number) ? 0 : 1;
  return `${number.toFixed(precision)}${unit}`;
}

function formatAxis(value, unit = "") {
  const number = finiteNumber(value);
  if (number === null) return "--";
  if (unit === "C") return `${Math.round(number)}C`;
  return Number.isInteger(number) ? `${number}` : number.toFixed(1);
}

function setBadge(element, level, value) {
  element.className = `badge ${level}`;
  element.textContent = value || labels[level] || "Info";
}

function setTile(tile, level, valueEl, detailEl, value, detail) {
  tile.className = `tile ${level}`;
  valueEl.textContent = value;
  detailEl.textContent = detail;
}

function facts(rows) {
  return rows
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
}

function evidenceFacts(element, rows) {
  if (!element) return;
  element.innerHTML = facts(rows);
}

function yesNo(value) {
  if (value === null || value === undefined) return "--";
  return value ? "YES" : "no";
}

function compactDurationSeconds(seconds) {
  const value = finiteNumber(seconds);
  return value === null ? "--" : durationText(value * 1000);
}

function miniBadge(level, value) {
  return `<span class="mini-badge ${escapeHtml(level)}">${escapeHtml(value)}</span>`;
}

function rowHealthLevel(row) {
  if (!row || !row.ok) return "critical";
  if (row.missing) return "critical";
  if (row.stale || row.calibrationWarning) return "warning";
  return "ok";
}

function rowHealthText(row) {
  if (!row || !row.ok) return "Map mismatch";
  if (row.missing) return "No reading";
  if (row.stale) return "Stale";
  if (row.calibrationWarning) return "Temp calibration";
  return "Current";
}

function readingValueText(reading) {
  if (!reading) return "--";
  const vwc = finiteNumber(reading.calibratedValue);
  const raw = finiteNumber(reading.rawValue);
  if (vwc !== null) return `${vwc.toFixed(1)}%`;
  if (raw !== null) return `raw ${Math.round(raw)}`;
  return "--";
}

function sensorNode(row) {
  const sensor = String((row && (row.actualSensor || row.expectedSensor)) || "");
  if (sensor.includes("D30GQN2D")) return "Node4";
  if (sensor.includes("D30GQN2E")) return "Node2";
  return sensor.split(":")[0] || "--";
}

function failureStreakText(row) {
  if (!row || row.missing) return "no reading";
  const age = finiteNumber(row.ageMinutes);
  const interval = intervalMinutes(row);
  if (age === null || interval === null) return "--";
  const missed = Math.max(0, Math.floor(age / interval) - 1);
  return missed ? `${missed} missed interval${missed === 1 ? "" : "s"}` : "0 missed";
}

function sensorGroupSummary(rows, groupName) {
  const groupRows = rows.filter((row) => sensorNode(row) === groupName);
  if (!groupRows.length) return "--";
  const stale = groupRows.filter((row) => row.stale).length;
  const missing = groupRows.filter((row) => row.missing).length;
  const current = Math.max(0, groupRows.length - stale - missing);
  return `${current}/${groupRows.length} current, ${stale + missing} stale/missing`;
}

function potNumberFromEvent(event) {
  if (!event) return null;
  const explicit = finiteNumber(event.physicalPot);
  if (explicit !== null) return explicit;
  const source = String(event.pairing || event.pairId || "");
  const match = source.match(/Pot(\d+)/i);
  return match ? Number(match[1]) : null;
}

function wateringEventsForDisplay(watering) {
  const events = Array.isArray(watering.events) ? watering.events.slice() : [];
  if (events.length || !watering.lastEvent) return events;
  const last = watering.lastEvent;
  return [{
    ...last,
    syntheticLatestEvent: true,
    t: last.t,
    pairing: last.pairing || last.pairId,
    physicalPot: potNumberFromEvent(last),
    valveOpenTimeMs: last.valveOpenTimeMs,
  }];
}

function renderPotCard(row) {
  const level = rowHealthLevel(row);
  const reading = row.latestReading || {};
  const detail = detailAttribute(row.softwarePairing || `Pot ${row.physicalPot}`, [
    ["Status", rowHealthText(row)],
    ["Pot", row.physicalPot === undefined ? "--" : `Pot ${row.physicalPot}`],
    ["Expected sensor", row.expectedSensor || "--"],
    ["Actual sensor", row.actualSensor || "--"],
    ["Valve", row.actualValve || row.expectedValve || "--"],
    ["Latest reading", dateTimeText(reading.createdAt)],
    ["Age", ageText(reading.createdAt)],
    ["VWC", reading.calibratedValue === undefined || reading.calibratedValue === null ? "--" : `${Number(reading.calibratedValue).toFixed(1)}%`],
    ["Raw", reading.rawValue === undefined || reading.rawValue === null ? "--" : Math.round(Number(reading.rawValue))],
    ["Watering", row.wateringDisabled ? "disabled" : "enabled"],
    ["Calibration", row.calibrationWarning || `id ${row.calibrationId || "--"}`],
  ], level);
  return `<article class="pot-card ${level}" data-detail="${detail}" tabindex="0" role="button">
    <div class="pot-disk"><span class="plant-sprout"></span><strong>${escapeHtml(row.physicalPot)}</strong></div>
    <div class="pot-card-body">
      <span class="pot-status">${escapeHtml(rowHealthText(row))}</span>
      <strong class="pot-reading">${escapeHtml(readingValueText(reading))}</strong>
      <small>${escapeHtml(row.actualSensor || row.expectedSensor || "--")}</small>
      <small>${escapeHtml(row.wateringDisabled ? "watering disabled" : row.calibrationWarning ? "temp calibration" : ageText(reading.createdAt))}</small>
    </div>
  </article>`;
}

function renderPotMap(rows) {
  if (!els.potMap) return;
  if (!rows.length) {
    els.potMap.innerHTML = `<div class="pot-empty">No Matt map rows loaded.</div>`;
    return;
  }
  const benches = [
    { label: "Zone 2", sub: "Pots 41-50", rows: rows.filter((row) => row.physicalPot >= 41 && row.physicalPot <= 50) },
    { label: "Zone 4", sub: "Pots 91-100", rows: rows.filter((row) => row.physicalPot >= 91 && row.physicalPot <= 100) },
  ];
  els.potMap.innerHTML = benches.map((bench) => `<div class="pot-bench">
    <div class="bench-label"><strong>${escapeHtml(bench.label)}</strong><span>${escapeHtml(bench.sub)}</span></div>
    <div class="pot-grid">${bench.rows.map(renderPotCard).join("")}</div>
  </div>`).join("");
}

function renderMattSensorTable(rows) {
  if (!els.mattSensorTable) return;
  if (!rows.length) {
    els.mattSensorTable.innerHTML = "";
    return;
  }
  els.mattSensorTable.innerHTML = `<table>
    <thead>
      <tr>
        <th>Group</th>
        <th>Pot</th>
        <th>Pairing</th>
        <th>Sensor</th>
        <th>Latest Reading</th>
        <th>Failure Streak</th>
        <th>Watering</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((row) => {
        const reading = row.latestReading || {};
        const level = rowHealthLevel(row);
        return `<tr>
          <td>${escapeHtml(sensorNode(row))}</td>
          <td><strong>Pot ${escapeHtml(row.physicalPot)}</strong></td>
          <td>${escapeHtml(row.softwarePairing || "--")}</td>
          <td>${escapeHtml(row.actualSensor || "--")}${row.actualSensor !== row.expectedSensor ? `<br><small>expected ${escapeHtml(row.expectedSensor || "--")}</small>` : ""}</td>
          <td><div class="reading-line"><strong>${escapeHtml(readingValueText(reading))}</strong><small>${escapeHtml(dateTimeText(reading.createdAt))} / ${escapeHtml(ageText(reading.createdAt))}</small></div></td>
          <td>${escapeHtml(failureStreakText(row))}</td>
          <td>${row.wateringDisabled ? miniBadge("neutral", "Disabled") : miniBadge("ok", "Enabled")}</td>
          <td>${miniBadge(level, rowHealthText(row))}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>`;
}

function detailRows(rows) {
  return `<dl class="detail-list">${rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("")}</dl>`;
}

function showDetail(payload) {
  if (!payload || !els.detailDrawer || !els.detailOverlay) return;
  els.detailTitle.textContent = payload.title || "Detail";
  els.detailDrawer.className = `detail-drawer open ${payload.level || "neutral"}`;
  els.detailBody.innerHTML = Array.isArray(payload.rows) ? detailRows(payload.rows) : "";
  els.detailOverlay.hidden = false;
  els.detailOverlay.classList.add("open");
  els.detailDrawer.setAttribute("aria-hidden", "false");
  els.detailClose.focus({ preventScroll: true });
}

function hideDetail() {
  if (!els.detailDrawer || !els.detailOverlay) return;
  els.detailDrawer.classList.remove("open");
  els.detailOverlay.classList.remove("open");
  els.detailDrawer.setAttribute("aria-hidden", "true");
  els.detailOverlay.hidden = true;
}

function setInteractiveDetail(element, title, rows, level = "neutral") {
  if (!element) return;
  element.dataset.detail = JSON.stringify({ title, rows, level });
  element.classList.add("interactive-detail");
  element.tabIndex = 0;
  element.setAttribute("role", "button");
}

function normalizePoint(point) {
  return {
    t: timestampMs(point && point.t),
    value: finiteNumber(point && point.value),
  };
}

function renderSeriesLine(points, geometry, timeRange, yMin, yMax, klass) {
  const { width, height, padLeft, padRight, padTop, padBottom } = geometry;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const range = Math.max(yMax - yMin, 1);
  const normalized = points.map(normalizePoint).filter((point) => point.value !== null);
  if (!normalized.length) return "";
  const hasTimeRange = timeRange.max > timeRange.min;
  const maxIndex = Math.max(normalized.length - 1, 1);
  const polyline = normalized
    .map((point, index) => {
      const x = hasTimeRange && point.t !== null
        ? geometry.padLeft + ((point.t - timeRange.min) / (timeRange.max - timeRange.min)) * plotWidth
        : geometry.padLeft + (index / maxIndex) * plotWidth;
      const y = height - padBottom - ((point.value - yMin) / range) * plotHeight;
      return `${clamp(x, padLeft, width - padRight).toFixed(1)},${clamp(y, padTop, height - padBottom).toFixed(1)}`;
    })
    .join(" ");
  return `<polyline points="${polyline}" class="chart-line ${klass}"></polyline>`;
}

function renderSeriesMarkers(points, geometry, timeRange, yMin, yMax, klass, label) {
  const { width, height, padLeft, padRight, padTop, padBottom } = geometry;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const range = Math.max(yMax - yMin, 1);
  const normalized = points.map(normalizePoint).filter((point) => point.value !== null);
  if (!normalized.length) return "";
  const hasTimeRange = timeRange.max > timeRange.min;
  const maxIndex = Math.max(normalized.length - 1, 1);
  const step = Math.max(1, Math.ceil(normalized.length / 120));
  return normalized
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => index === normalized.length - 1 || index % step === 0)
    .map(({ point, index }) => {
      const x = hasTimeRange && point.t !== null
        ? geometry.padLeft + ((point.t - timeRange.min) / (timeRange.max - timeRange.min)) * plotWidth
        : geometry.padLeft + (index / maxIndex) * plotWidth;
      const y = height - padBottom - ((point.value - yMin) / range) * plotHeight;
      const sampledAt = point.t === null ? "sample" : dateTimeText(new Date(point.t).toISOString());
      const title = `${label}: ${formatNumber(point.value)} at ${sampledAt}`;
      const detail = detailAttribute(label, [
        ["Value", formatNumber(point.value)],
        ["Sample time", sampledAt],
        ["Series", label],
      ], klass === "danger" || klass === "warning" ? "warning" : "neutral");
      return `<circle cx="${clamp(x, padLeft, width - padRight).toFixed(1)}" cy="${clamp(y, padTop, height - padBottom).toFixed(1)}" r="4.2" class="chart-point ${klass}" tabindex="0" role="button" aria-label="${escapeHtml(title)}" data-detail="${detail}"><title>${escapeHtml(title)}</title></circle>`;
    })
    .join("");
}

function renderLineChart({ series, yMin = 0, yMax = null, unit = "", yTitle = "", emptyText = "No samples yet", controlsHtml = "" }) {
  const width = 760;
  const height = 270;
  const geometry = { width, height, padLeft: 62, padRight: 18, padTop: 34, padBottom: 48 };
  const allPoints = series.flatMap((item) => item.points || []).map(normalizePoint);
  const values = allPoints.map((point) => point.value).filter((value) => value !== null);
  const times = allPoints.map((point) => point.t).filter((value) => value !== null);
  const computedMax = yMax === null ? Math.max(yMin + 1, ...values, 1) : Math.max(yMax, yMin + 1);
  const timeRange = {
    min: times.length ? Math.min(...times) : 0,
    max: times.length ? Math.max(...times) : 0,
  };
  const midY = yMin + (computedMax - yMin) / 2;
  const plotBottom = height - geometry.padBottom;
  const plotRight = width - geometry.padRight;
  const plotMiddleY = geometry.padTop + (plotBottom - geometry.padTop) / 2;
  const startLabel = times.length ? chartTimeLabel(new Date(timeRange.min).toISOString()) : "start";
  const midLabel = times.length ? chartTimeLabel(new Date((timeRange.min + timeRange.max) / 2).toISOString()) : "";
  const endLabel = times.length ? chartTimeLabel(new Date(timeRange.max).toISOString()) : "now";
  const legend = `<div class="chart-legend">${series.map((item) => `<span><i class="${item.klass}"></i>${escapeHtml(item.label)}</span>`).join("")}</div>`;
  const lines = series.map((item) => renderSeriesLine(item.points || [], geometry, timeRange, yMin, computedMax, item.klass)).join("");
  const markers = series.map((item) => renderSeriesMarkers(item.points || [], geometry, timeRange, yMin, computedMax, item.klass, item.label)).join("");

  return `${controlsHtml}${legend}<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(yTitle || "Health trend")}">
    <line x1="${geometry.padLeft}" y1="${geometry.padTop}" x2="${plotRight}" y2="${geometry.padTop}" class="chart-grid-line"></line>
    <line x1="${geometry.padLeft}" y1="${plotMiddleY}" x2="${plotRight}" y2="${plotMiddleY}" class="chart-grid-line"></line>
    <line x1="${geometry.padLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" class="chart-axis-line"></line>
    <line x1="${geometry.padLeft}" y1="${geometry.padTop}" x2="${geometry.padLeft}" y2="${plotBottom}" class="chart-axis-line"></line>
    <text x="${geometry.padLeft - 9}" y="${geometry.padTop + 4}" text-anchor="end" class="chart-axis">${formatAxis(computedMax, unit)}</text>
    <text x="${geometry.padLeft - 9}" y="${plotMiddleY + 4}" text-anchor="end" class="chart-axis">${formatAxis(midY, unit)}</text>
    <text x="${geometry.padLeft - 9}" y="${plotBottom + 4}" text-anchor="end" class="chart-axis">${formatAxis(yMin, unit)}</text>
    ${yTitle ? `<text x="${geometry.padLeft}" y="17" class="chart-axis-title">${escapeHtml(yTitle)}</text>` : ""}
    ${lines}
    ${markers}
    <text x="${geometry.padLeft}" y="${height - 12}" class="chart-axis x-axis">${escapeHtml(startLabel)}</text>
    <text x="${(geometry.padLeft + plotRight) / 2}" y="${height - 12}" text-anchor="middle" class="chart-axis x-axis">${escapeHtml(midLabel)}</text>
    <text x="${plotRight}" y="${height - 12}" text-anchor="end" class="chart-axis x-axis">${escapeHtml(endLabel)}</text>
    ${values.length ? "" : `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="chart-empty">${escapeHtml(emptyText)}</text>`}
  </svg>`;
}

function renderWaterEventChart(events, historyRecords, controlsHtml = "") {
  const openedLastHour = historyRecords.map((record) => ({ t: record.t, value: record.wateringOpenedLastHour }));
  if (!events.length) {
    return renderLineChart({
      series: [{ label: "Water events last hour", klass: "primary", points: openedLastHour }],
      yMin: 0,
      yTitle: "Valve opens per hour",
      emptyText: "No watering events loaded yet",
      controlsHtml,
    });
  }

  const width = 760;
  const height = 270;
  const geometry = { width, height, padLeft: 66, padRight: 20, padTop: 34, padBottom: 48 };
  const times = events.map((event) => timestampMs(event.t)).filter((value) => value !== null);
  const historyTimes = graphRecordTimes(historyRecords);
  const timeMin = historyTimes.length ? Math.min(...historyTimes) : Math.min(...times);
  const timeMax = historyTimes.length ? Math.max(...historyTimes) : Math.max(...times);
  const timeRange = timeMax > timeMin ? timeMax - timeMin : 1;
  const labelsByKey = new Map();
  events.forEach((event) => {
    const key = event.physicalPot !== null && event.physicalPot !== undefined ? `Pot ${event.physicalPot}` : `S${event.sensorId || "?"}`;
    labelsByKey.set(key, key);
  });
  const yLabels = Array.from(labelsByKey.keys()).sort((a, b) => {
    const na = Number(a.replace(/\D/g, ""));
    const nb = Number(b.replace(/\D/g, ""));
    return na - nb;
  });
  const yIndex = new Map(yLabels.map((label, index) => [label, index]));
  const plotWidth = width - geometry.padLeft - geometry.padRight;
  const plotHeight = height - geometry.padTop - geometry.padBottom;
  const denom = Math.max(yLabels.length - 1, 1);
  const yForLabel = (label) => {
    if (yLabels.length === 1) return geometry.padTop + plotHeight / 2;
    return height - geometry.padBottom - ((yIndex.get(label) || 0) / denom) * plotHeight;
  };
  const tickLabels = [yLabels[0], yLabels[Math.floor(yLabels.length / 2)], yLabels[yLabels.length - 1]].filter(Boolean);
  const circles = events
    .map((event) => {
      const eventTime = timestampMs(event.t);
      if (eventTime === null) return "";
      const key = event.physicalPot !== null && event.physicalPot !== undefined ? `Pot ${event.physicalPot}` : `S${event.sensorId || "?"}`;
      const x = geometry.padLeft + ((eventTime - timeMin) / timeRange) * plotWidth;
      const y = yForLabel(key);
      const duration = finiteNumber(event.valveOpenTimeMs);
      const title = `${key} opened ${dateTimeText(event.t)}${duration === null ? "" : ` for ${Math.round(duration / 1000)}s`}`;
      const detail = detailAttribute(event.pairing || key, [
        ["Event", "Valve opened"],
        ["Time", dateTimeText(event.t)],
        ["Age", ageText(event.t)],
        ["Pot", event.physicalPot === null || event.physicalPot === undefined ? "--" : `Pot ${event.physicalPot}`],
        ["Pairing", event.pairing || "--"],
        ["Sensor", event.sensor || event.sensorId || "--"],
        ["Valve", event.valve || event.valveId || "--"],
        ["Duration", duration === null ? "--" : `${Math.round(duration / 1000)} sec`],
        ["Event ID", event.id || "--"],
      ], "ok");
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" class="event-dot" tabindex="0" role="button" aria-label="${escapeHtml(title)}" data-detail="${detail}"><title>${escapeHtml(title)}</title></circle>`;
    })
    .join("");
  const tickMarkup = tickLabels
    .map((label) => {
      const y = yForLabel(label);
      return `<line x1="${geometry.padLeft}" y1="${y}" x2="${width - geometry.padRight}" y2="${y}" class="chart-grid-line"></line>
        <text x="${geometry.padLeft - 8}" y="${y + 4}" text-anchor="end" class="chart-axis">${escapeHtml(label)}</text>`;
    })
    .join("");
  const startLabel = chartTimeLabel(new Date(timeMin).toISOString());
  const midLabel = chartTimeLabel(new Date((timeMin + timeMax) / 2).toISOString());
  const endLabel = chartTimeLabel(new Date(timeMax).toISOString());

  const eventList = events
    .slice()
    .sort((a, b) => timestampMs(b.t) - timestampMs(a.t))
    .slice(0, 8)
    .map((event) => {
      const duration = finiteNumber(event.valveOpenTimeMs);
      const title = event.pairing || (event.physicalPot === null || event.physicalPot === undefined ? `S${event.sensorId || "?"}` : `Pot ${event.physicalPot}`);
      const detail = detailAttribute(title, [
        ["Event", "Valve opened"],
        ["Time", dateTimeText(event.t)],
        ["Age", ageText(event.t)],
        ["Pot", event.physicalPot === null || event.physicalPot === undefined ? "--" : `Pot ${event.physicalPot}`],
        ["Pairing", event.pairing || "--"],
        ["Sensor", event.sensor || event.sensorId || "--"],
        ["Valve", event.valve || event.valveId || "--"],
        ["Duration", duration === null ? "--" : `${Math.round(duration / 1000)} sec`],
      ], "ok");
      return `<button class="event-row" type="button" data-detail="${detail}">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(dateTimeText(event.t))}</span>
        <small>${escapeHtml(duration === null ? "duration unknown" : `${Math.round(duration / 1000)} sec`)}</small>
      </button>`;
    })
    .join("");

  const shownLabel = events.some((event) => event.syntheticLatestEvent) ? `${events.length} latest shown` : `${events.length} shown`;
  return `${controlsHtml}<div class="chart-legend"><span><i class="primary"></i>Valve open event</span><span><i class="secondary"></i>${escapeHtml(shownLabel)}</span></div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Watering event timeline">
      ${tickMarkup}
      <line x1="${geometry.padLeft}" y1="${height - geometry.padBottom}" x2="${width - geometry.padRight}" y2="${height - geometry.padBottom}" class="chart-axis-line"></line>
      <line x1="${geometry.padLeft}" y1="${geometry.padTop}" x2="${geometry.padLeft}" y2="${height - geometry.padBottom}" class="chart-axis-line"></line>
      <text x="${geometry.padLeft}" y="17" class="chart-axis-title">Watering events by sensor/pot</text>
      ${circles}
      <text x="${geometry.padLeft}" y="${height - 12}" class="chart-axis x-axis">${escapeHtml(startLabel)}</text>
      <text x="${(geometry.padLeft + width - geometry.padRight) / 2}" y="${height - 12}" text-anchor="middle" class="chart-axis x-axis">${escapeHtml(midLabel)}</text>
      <text x="${width - geometry.padRight}" y="${height - 12}" text-anchor="end" class="chart-axis x-axis">${escapeHtml(endLabel)}</text>
    </svg>
    <div class="event-list">${eventList}</div>`;
}

function ethernetSample(data) {
  const ownerStatus = getOwnerStatus(data);
  const eth = data.piLocal && data.piLocal.available ? data.piLocal.ethernet || {} : data.confirmedPiEthernet || {};
  const carrier = eth.linkDetected === true || eth.carrier === "1" || eth.ok === true;
  const ip = eth.ipv4 || "";
  return {
    up: carrier && Boolean(ip),
    carrier,
    ip,
    gatewayPingMs: finiteNumber(eth.gatewayPingMs),
    apiOk: Boolean(data.api && data.api.healthcheck && data.api.healthcheck.ok),
    publicOk: ownerStatus.public_url_reachable !== undefined
      ? Boolean(ownerStatus.public_url_reachable)
      : Boolean(data.publicUrl && data.publicUrl.ownerHealth && data.publicUrl.ownerHealth.ok),
  };
}

function powerSample(data) {
  const pi = data.piLocal || {};
  const resources = pi.resources || {};
  const hardware = pi.hardware || {};
  const undervoltage = hardware.undervoltageAlarm;
  return {
    tempC: finiteNumber(resources.temperatureC),
    undervoltage: undervoltage === true || undervoltage === 1 || undervoltage === "1",
    undervoltageKnown: undervoltage !== null && undervoltage !== undefined,
    uptimeSeconds: finiteNumber(hardware.uptimeSeconds),
  };
}

function intervalMinutes(row) {
  const value = finiteNumber(row && row.MeasurementInterval);
  if (value === null || value <= 0) return null;
  return Math.max(1, Math.round(value / 60000));
}

function maxExpectedAgeMinutes(row) {
  const minutes = intervalMinutes(row);
  if (minutes === null) return DEFAULT_SENSOR_STALE_MINUTES;
  return Math.max(minutes * 2, minutes + 5);
}

function sensorRows(data) {
  return ((((data.api || {}).researcherMap || {}).rows) || []).map((row) => {
    const readingAt = row.latestReading && row.latestReading.createdAt;
    const age = ageMinutes(readingAt);
    const maxAge = maxExpectedAgeMinutes(row);
    return {
      ...row,
      readingAt,
      ageMinutes: age,
      maxAgeMinutes: maxAge,
      missing: !row.latestReading,
      stale: age !== null && age > maxAge,
    };
  });
}

function latestStoredReading(rows) {
  return rows
    .map((row) => row.readingAt)
    .filter(Boolean)
    .sort((a, b) => timestampMs(b) - timestampMs(a))[0] || null;
}

function currentHistoryRecord(data) {
  const ownerStatus = getOwnerStatus(data);
  const ethernet = ethernetSample(data);
  const power = powerSample(data);
  const rows = sensorRows(data);
  const staleOrMissing = rows.filter((row) => row.missing || row.stale).length;
  const watering = ((data.api || {}).watering) || {};
  return {
    t: data.generatedAt,
    ethUp: ownerStatus.ethernet_link !== undefined ? ownerStatus.ethernet_link : ethernet.up,
    apiOk: ownerStatus.api_status !== undefined ? ownerStatus.api_status === "OK" : ethernet.apiOk,
    publicOk: ownerStatus.public_url_reachable !== undefined ? ownerStatus.public_url_reachable : ethernet.publicOk,
    gatewayPingMs: ownerStatus.gateway_ping_ms !== undefined ? ownerStatus.gateway_ping_ms : ethernet.gatewayPingMs,
    cpuTempC: ownerStatus.cpu_temp_c !== undefined ? ownerStatus.cpu_temp_c : power.tempC,
    undervoltage: ownerStatus.undervoltage !== undefined ? ownerStatus.undervoltage : power.undervoltage,
    undervoltageCurrent: ownerStatus.undervoltage_current !== undefined ? ownerStatus.undervoltage_current : power.undervoltage,
    undervoltageOccurred: ownerStatus.undervoltage_occurred,
    powerSuspected: ownerStatus.power_suspected,
    uptimeSeconds: ownerStatus.current_uptime_seconds !== undefined ? ownerStatus.current_uptime_seconds : power.uptimeSeconds,
    restartCountLast24h: ownerStatus.restart_count_last_24h,
    sensorRows: ownerStatus.sensors_expected !== undefined ? ownerStatus.sensors_expected : rows.length,
    staleOrMissingSensors: ownerStatus.sensors_stale !== undefined || ownerStatus.sensors_missing !== undefined
      ? (ownerStatus.sensors_stale || 0) + (ownerStatus.sensors_missing || 0)
      : staleOrMissing,
    wateringOpenedLastHour: watering.lastHour,
    wateringOpenedLast24h: ownerStatus.watering_events_last_24h !== undefined ? ownerStatus.watering_events_last_24h : watering.last24h,
    wateringLastAt: ownerStatus.watering_last_event_at || (watering.lastEvent && watering.lastEvent.t),
    schedulerPending: ownerStatus.scheduler_jobs_loaded !== undefined ? ownerStatus.scheduler_jobs_loaded : data.scheduler && data.scheduler.totalPending,
    schedulerExpectedMattJobs: ownerStatus.scheduler_expected_matt_jobs !== undefined ? ownerStatus.scheduler_expected_matt_jobs : rows.length,
    schedulerExtraJobsLoaded: ownerStatus.scheduler_extra_jobs_loaded,
  };
}

function chartHistoryRecords(data) {
  const records = [...(Array.isArray(data.historyRecords) ? data.historyRecords : []), currentHistoryRecord(data)]
    .filter((record) => record && record.t)
    .sort((a, b) => timestampMs(a.t) - timestampMs(b.t));
  const seen = new Set();
  return records.filter((record) => {
    const key = record.t;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isConnectivityDown(record) {
  if (!record) return false;
  return record.ethUp === false || record.apiOk === false || record.publicOk === false;
}

function connectivityReasons(record) {
  const reasons = [];
  if (!record) return reasons;
  if (record.ethUp === false) reasons.push("Ethernet link not confirmed");
  if (record.apiOk === false) reasons.push("Controller API unreachable");
  if (record.publicOk === false) reasons.push("Balena public path down");
  if (record.error) reasons.push("Health sampler error");
  return reasons;
}

function detectConnectivityEvents(records, sampleIntervalSeconds = 300) {
  const sorted = records
    .filter((record) => record && record.t && timestampMs(record.t) !== null)
    .sort((a, b) => timestampMs(a.t) - timestampMs(b.t));
  if (sorted.length < 2) return [];

  const gapThresholdMs = Math.max(8 * 60 * 1000, sampleIntervalSeconds * 2.25 * 1000);
  const events = [];
  let activeDown = null;

  sorted.forEach((record, index) => {
    const recordTime = timestampMs(record.t);
    const previous = index ? sorted[index - 1] : null;
    const previousTime = previous ? timestampMs(previous.t) : null;
    const down = isConnectivityDown(record);

    if (previous && previousTime !== null) {
      const gapMs = recordTime - previousTime;
      const previousUptime = finiteNumber(previous.uptimeSeconds);
      const currentUptime = finiteNumber(record.uptimeSeconds);
      const serviceRestarted = previousUptime !== null && currentUptime !== null && currentUptime + 90 < previousUptime;

      if (gapMs > gapThresholdMs) {
        events.push({
          type: "sample-gap",
          level: down ? "warning" : "ok",
          title: down ? "Monitoring gap, still recovering" : "Monitoring gap recovered",
          start: previous.t,
          end: record.t,
          durationMs: gapMs,
          reasons: ["No health samples were written during this window"],
          recovered: !down,
        });
      }

      if (serviceRestarted) {
        events.push({
          type: "service-restart",
          level: down ? "warning" : "ok",
          title: down ? "Dashboard service restarted, still recovering" : "Dashboard service restarted",
          start: previous.t,
          end: record.t,
          durationMs: gapMs,
          reasons: ["Uptime counter reset between samples"],
          recovered: !down,
        });
      }
    }

    if (down) {
      if (!activeDown) {
        activeDown = {
          type: "connectivity-down",
          level: "critical",
          title: "Connectivity outage in progress",
          start: previous && previous.t ? previous.t : record.t,
          firstBad: record.t,
          end: null,
          reasons: [],
          samples: 0,
          recovered: false,
        };
      }
      activeDown.samples += 1;
      activeDown.lastBad = record.t;
      activeDown.reasons = Array.from(new Set([...activeDown.reasons, ...connectivityReasons(record)]));
    } else if (activeDown) {
      activeDown.end = record.t;
      activeDown.durationMs = timestampMs(activeDown.end) - timestampMs(activeDown.start);
      activeDown.level = "ok";
      activeDown.title = "Connectivity outage recovered";
      activeDown.recovered = true;
      events.push(activeDown);
      activeDown = null;
    }
  });

  if (activeDown) {
    activeDown.durationMs = Date.now() - timestampMs(activeDown.start);
    events.push(activeDown);
  }

  return events.sort((a, b) => timestampMs(b.end || b.lastBad || b.start) - timestampMs(a.end || a.lastBad || a.start));
}

function eventPlainSummary(event) {
  const reasons = event && event.reasons ? event.reasons : [];
  if (reasons.includes("Controller API unreachable") && reasons.includes("Balena public path down")) {
    return "API and public URL down";
  }
  if (reasons.includes("Controller API unreachable")) return "API down";
  if (reasons.includes("Balena public path down")) return "Public URL down";
  if (reasons.includes("No health samples were written during this window")) return "No samples written";
  if (reasons.includes("Uptime counter reset between samples")) return "Service restarted";
  return reasons[0] || "Connectivity changed";
}

function outageWindowSignal(event) {
  if (!event) return null;
  if (event.type === "connectivity-down") return "Public/API outage";
  if (event.type === "sample-gap") return "Monitoring gap";
  if (event.type === "service-restart") return "Restart detected";
  return eventPlainSummary(event);
}

function collapseOutageWindows(events) {
  const mergeSlackMs = 60 * 1000;
  const rows = events
    .filter((event) => event && event.start && event.type !== "service-restart")
    .map((event) => {
      const startMs = timestampMs(event.start);
      const endMs = timestampMs(event.end || event.lastBad || event.start);
      if (startMs === null || endMs === null) return null;
      return {
        ...event,
        startMs,
        endMs,
        signals: [outageWindowSignal(event)].filter(Boolean),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs);

  const windows = [];
  rows.forEach((event) => {
    const previous = windows[windows.length - 1];
    if (previous && event.startMs <= previous.endMs + mergeSlackMs) {
      previous.endMs = Math.max(previous.endMs, event.endMs);
      previous.end = previous.endMs === event.endMs ? event.end : previous.end;
      previous.durationMs = previous.endMs - previous.startMs;
      previous.recovered = previous.recovered || event.recovered;
      previous.level = previous.recovered ? "ok" : "critical";
      previous.signals = Array.from(new Set([...previous.signals, ...event.signals]));
      previous.reasons = Array.from(new Set([...(previous.reasons || []), ...(event.reasons || [])]));
      return;
    }
    windows.push({
      ...event,
      title: event.recovered ? "Connectivity outage recovered" : "Connectivity outage in progress",
      durationMs: event.endMs - event.startMs,
    });
  });

  return windows.sort((a, b) => b.endMs - a.endMs);
}

function detectRestartEvents(records) {
  const sorted = records
    .filter((record) => record && record.t && finiteNumber(record.uptimeSeconds) !== null)
    .sort((a, b) => timestampMs(a.t) - timestampMs(b.t));
  const restarts = [];
  let previous = null;
  sorted.forEach((record) => {
    const uptime = finiteNumber(record.uptimeSeconds);
    const previousUptime = previous ? finiteNumber(previous.uptimeSeconds) : null;
    if (previous && previousUptime !== null && uptime !== null && uptime + 90 < previousUptime) {
      restarts.push({
        t: record.t,
        previous: previous.t,
        uptimeSeconds: uptime,
        previousUptimeSeconds: previousUptime,
      });
    }
    previous = record;
  });
  return restarts;
}

function updateRestartEvidence(data) {
  if (!els.restartGraph) return;
  const ownerStatus = getOwnerStatus(data);
  const allHistoryRecords = chartHistoryRecords(data);
  const historyRecords = filterRecordsForGraphWindow(allHistoryRecords);
  const graphControls = renderGraphControls(allHistoryRecords);
  const sampleIntervalSeconds = data.historyMeta && data.historyMeta.sampleIntervalSeconds
    ? data.historyMeta.sampleIntervalSeconds
    : 300;
  const restartEvents = detectRestartEvents(historyRecords);
  const connectivityEvents = detectConnectivityEvents(historyRecords, sampleIntervalSeconds);
  const outageWindows = collapseOutageWindows(connectivityEvents);
  const latestOutage = outageWindows[0];
  const current = currentHistoryRecord(data);
  const currentDown = isConnectivityDown(current);
  const currentUptime = ownerStatus.current_uptime_seconds !== undefined
    ? finiteNumber(ownerStatus.current_uptime_seconds)
    : powerSample(data).uptimeSeconds;
  const count = restartEvents.length;
  const displayedRestartEvents = restartEvents;
  const outageCount = outageWindows.length;
  const level = currentDown || ownerStatus.undervoltage_current ? "critical" : count || outageCount || (currentUptime !== null && currentUptime < 600) ? "warning" : "ok";
  const latestOutageText = latestOutage
    ? `${dateTimeText(latestOutage.start)} to ${latestOutage.end ? dateTimeText(latestOutage.end) : "still down"}`
    : "none detected";
  setBadge(els.restartBadge, level, count || outageCount ? `${count} restarts / ${outageCount} outages` : "Stable");
  els.restartDetail.textContent = count || outageCount
    ? `Uptime should climb; red marks show detected resets, orange marks show down samples. ${count} restart${count === 1 ? "" : "s"}, ${outageCount} outage window${outageCount === 1 ? "" : "s"}.`
    : `Uptime should climb; no reset or outage window detected.`;
  els.restartFacts.innerHTML = facts([
    ["Now", `${currentDown ? "down/degraded" : "up"}; uptime ${compactDurationSeconds(currentUptime)}`],
    ["Restarts shown", count],
    ["Latest restart", dateTimeText((displayedRestartEvents[displayedRestartEvents.length - 1] || {}).t)],
    ["Latest outage", latestOutageText],
    ["Outage duration", latestOutage ? durationText(latestOutage.durationMs) : "--"],
  ]);

  const uptimeMinutes = historyRecords.map((record) => ({
    t: record.t,
    value: finiteNumber(record.uptimeSeconds) === null ? null : finiteNumber(record.uptimeSeconds) / 60,
  }));
  const maxUptime = Math.max(10, ...uptimeMinutes.map((point) => point.value || 0));
  const restartTimes = new Set(displayedRestartEvents.map((event) => event.t));
  const restartMarkers = historyRecords.map((record) => ({
    t: record.t,
    value: restartTimes.has(record.t) || (finiteNumber(record.uptimeSeconds) !== null && finiteNumber(record.uptimeSeconds) < 90) ? maxUptime : 0,
  }));
  const outageMarkers = historyRecords.map((record) => ({
    t: record.t,
    value: isConnectivityDown(record) ? maxUptime * 0.72 : 0,
  }));
  els.restartGraph.innerHTML = renderLineChart({
    series: [
      { label: "Host uptime minutes", klass: "primary", points: uptimeMinutes },
      { label: "Restart detected", klass: "danger", points: restartMarkers },
      { label: "Connectivity down", klass: "warning", points: outageMarkers },
    ],
    yMin: 0,
    yMax: maxUptime,
    yTitle: "Uptime minutes",
    controlsHtml: graphControls,
  });
  renderRestartOutageLog(outageWindows, displayedRestartEvents);
}

function renderRestartOutageLog(outageWindows, restartEvents) {
  if (!els.restartEventLog) return;
  const outageRows = outageWindows.map((event) => ({
    kind: "Outage",
    level: event.recovered ? "ok" : "critical",
    start: event.start,
    end: event.end,
    durationMs: event.durationMs,
    status: event.recovered ? "Recovered" : "Still down",
    signal: (event.signals || []).join(", ") || eventPlainSummary(event),
    sortAt: timestampMs(event.end || event.lastBad || event.start) || 0,
  }));
  const restartRows = restartEvents.map((event) => ({
    kind: "Restart",
    level: "warning",
    start: event.previous,
    end: event.t,
    durationMs: (timestampMs(event.t) || 0) - (timestampMs(event.previous) || 0),
    status: `uptime reset to ${compactDurationSeconds(event.uptimeSeconds)}`,
    signal: `previous uptime ${compactDurationSeconds(event.previousUptimeSeconds)}`,
    sortAt: timestampMs(event.t) || 0,
  }));
  const rows = [...outageRows, ...restartRows]
    .sort((a, b) => b.sortAt - a.sortAt)
    .slice(0, 12);
  if (!rows.length) {
    els.restartEventLog.innerHTML = "";
    return;
  }
  els.restartEventLog.innerHTML = `<div class="outage-log-head">
      <strong>Evidence log</strong>
      <span>${outageRows.length} outage${outageRows.length === 1 ? "" : "s"} / ${restartRows.length} restart${restartRows.length === 1 ? "" : "s"} in selected window</span>
    </div>
    <div class="outage-log-list">
      ${rows.map((event) => {
        const end = event.end ? dateTimeText(event.end) : "still down";
        const detail = detailAttribute(`${event.kind} evidence`, [
          ["Type", event.kind],
          ["Start", dateTimeText(event.start)],
          ["Finish", end],
          ["Duration", durationText(event.durationMs)],
          ["Status", event.status],
          ["Signal", event.signal],
        ], event.level);
        return `<button class="outage-row ${event.level}" type="button" data-detail="${detail}">
          <span>${escapeHtml(event.kind)}: ${escapeHtml(dateTimeText(event.start))} - ${escapeHtml(end)}</span>
          <strong>${escapeHtml(durationText(event.durationMs))}</strong>
          <small>${escapeHtml(event.status)}</small>
        </button>`;
      }).join("")}
    </div>`;
}

function getNetworkStatus(data) {
  const ownerStatus = getOwnerStatus(data);
  if (ownerStatus.overall_status) {
    const hasPublic = ownerStatus.public_url_reachable !== false;
    if (ownerStatus.ethernet_link && ownerStatus.api_status === "OK" && hasPublic) {
      return {
        level: "ok",
        value: "Online",
        detail: `${ownerStatus.ethernet_ip || "eth0"} linked${ownerStatus.gateway_ping_ms === null || ownerStatus.gateway_ping_ms === undefined ? "" : `; gateway ${ownerStatus.gateway_ping_ms} ms`}`,
      };
    }
    if (ownerStatus.ethernet_link) {
      return {
        level: "warning",
        value: "Linked",
        detail: `${ownerStatus.ethernet_ip || "eth0"} linked; public/API path needs attention`,
      };
    }
    return { level: "critical", value: "Offline", detail: "Ethernet link is not confirmed" };
  }
  const eth = ethernetSample(data);
  if (eth.up && eth.apiOk) return { level: "ok", value: "Online", detail: `${eth.ip || "eth0"} linked; app reachable` };
  if (eth.up) return { level: "warning", value: "Linked", detail: `${eth.ip || "eth0"} linked; app check is degraded` };
  return { level: "critical", value: "Offline", detail: "Ethernet link or controller IP is not confirmed" };
}

function getPowerStatus(data) {
  const ownerStatus = getOwnerStatus(data);
  if (ownerStatus.overall_status) {
    if (ownerStatus.undervoltage_current) return { level: "critical", value: "Alarm", detail: "Undervoltage is active right now" };
    if (ownerStatus.undervoltage_occurred) return { level: "warning", value: "Latched", detail: "Undervoltage occurred since boot" };
    if (ownerStatus.power_suspected) return { level: "warning", value: "Suspect", detail: `${ownerStatus.restart_count_last_24h || 0} restarts in 24h; uptime ${compactDurationSeconds(ownerStatus.current_uptime_seconds)}` };
    if (ownerStatus.current_uptime_seconds !== undefined && ownerStatus.current_uptime_seconds !== null && ownerStatus.current_uptime_seconds < 600) {
      return { level: "warning", value: "Restarted", detail: `Current uptime ${compactDurationSeconds(ownerStatus.current_uptime_seconds)}` };
    }
    if (ownerStatus.cpu_temp_c !== null && ownerStatus.cpu_temp_c !== undefined) {
      return { level: "ok", value: `${Number(ownerStatus.cpu_temp_c).toFixed(1)} C`, detail: `Power alarm off; uptime ${compactDurationSeconds(ownerStatus.current_uptime_seconds)}` };
    }
    return { level: "warning", value: "Unknown", detail: "Power telemetry is unavailable" };
  }
  const power = powerSample(data);
  if (power.undervoltage) return { level: "critical", value: "Alarm", detail: "Undervoltage is active or latched" };
  if (power.tempC !== null) return { level: "ok", value: `${power.tempC.toFixed(1)} C`, detail: "Power alarm off" };
  return { level: "warning", value: "Unknown", detail: "Power telemetry is unavailable" };
}

function getSensorStatus(data) {
  const ownerStatus = getOwnerStatus(data);
  if (ownerStatus.overall_status && ownerStatus.sensors_expected !== undefined) {
    const expected = ownerStatus.sensors_expected || 0;
    const current = ownerStatus.sensors_current || 0;
    const stale = ownerStatus.sensors_stale || 0;
    const missing = ownerStatus.sensors_missing || 0;
    if (!expected) return { level: "warning", value: "No rows", detail: "Sensor map has not loaded" };
    if (missing || stale) return { level: "warning", value: `${current}/${expected}`, detail: `${stale} not updating, ${missing} with no stored reading` };
    if ((ownerStatus.config_warnings || []).length || (ownerStatus.calibration_warnings || []).length) {
      return { level: "warning", value: `${current}/${expected}`, detail: "Readings current; experiment config has warnings" };
    }
    return { level: "ok", value: `${current}/${expected}`, detail: "All mapped sensors have recent readings" };
  }
  const rows = sensorRows(data);
  const missing = rows.filter((row) => row.missing).length;
  const stale = rows.filter((row) => row.stale).length;
  const healthy = Math.max(0, rows.length - missing - stale);
  if (!rows.length) return { level: "warning", value: "No rows", detail: "Sensor map has not loaded" };
  if (missing || stale) return { level: "warning", value: `${healthy}/${rows.length}`, detail: `${stale} not updating, ${missing} with no stored reading` };
  return { level: "ok", value: `${rows.length}/${rows.length}`, detail: "All mapped sensors have recent readings" };
}

function updateSummary(data) {
  const ownerStatus = getOwnerStatus(data);
  const ownerOverall = ownerStatus.overall_status;
  const level = ownerOverall ? levelFromOwnerStatus(ownerOverall) : (data.overall && data.overall.level) || "neutral";
  els.summary.className = `summary ${level}`;
  setBadge(els.summaryBadge, level, ownerOverall ? statusLabel(ownerOverall) : labels[level]);
  els.overallTitle.textContent = ownerOverall ? statusLabel(ownerOverall) : data.overall && data.overall.title ? data.overall.title : "Status unknown";
  const ownerAlerts = ownerStatus.active_alerts || [];
  const knownIssues = ownerStatus.known_issues || [];
  const issues = ownerAlerts.length
    ? ownerAlerts
    : knownIssues.length
      ? knownIssues.map((issue) => `Known issue: ${issue}.`)
      : (data.overall && data.overall.issues) || [];
  const warnings = ownerAlerts.length || knownIssues.length ? [] : (data.overall && data.overall.warnings) || [];
  els.overallDetail.textContent = issues.length || warnings.length
    ? [...issues, ...warnings].join(" ")
    : "Controller power, ethernet, sensors, and watering scheduler are reporting normally.";
}

function updateTiles(data) {
  const ownerStatus = getOwnerStatus(data);
  const apiOk = Boolean(data.api && data.api.healthcheck && data.api.healthcheck.ok);
  const state = data.api && data.api.system && data.api.system.data && data.api.system.data.state;
  const controllerLevel = ownerStatus.api_status ? levelFromOwnerStatus(ownerStatus.api_status === "OK" ? "OK" : "DOWN") : apiOk ? "ok" : "critical";
  const controllerValue = ownerStatus.api_status || (apiOk ? text(state) : "Down");
  const controllerDetail = ownerStatus.scheduler_jobs_loaded !== undefined
    ? `${ownerStatus.scheduler_jobs_loaded} scheduler jobs loaded${ownerStatus.scheduler_extra_jobs_loaded ? `; ${ownerStatus.scheduler_extra_jobs_loaded} extra` : ""}; checked ${dateTimeText(ownerStatus.last_checked_at)}`
    : apiOk ? `${data.api.healthcheck.elapsedMs} ms API response` : "API healthcheck failed";
  setTile(
    els.systemTile,
    controllerLevel,
    els.systemTileValue,
    els.systemTileDetail,
    controllerValue,
    controllerDetail
  );
  setInteractiveDetail(els.systemTile, "Controller", [
    ["Status", controllerValue],
    ["System state", state || "--"],
    ["API response", apiOk && data.api.healthcheck ? `${data.api.healthcheck.elapsedMs} ms` : "failed"],
    ["Scheduler jobs", ownerStatus.scheduler_jobs_loaded !== undefined ? ownerStatus.scheduler_jobs_loaded : "--"],
    ["Expected Matt jobs", ownerStatus.scheduler_expected_matt_jobs !== undefined ? ownerStatus.scheduler_expected_matt_jobs : "--"],
    ["Extra jobs loaded", ownerStatus.scheduler_extra_jobs_loaded !== undefined ? ownerStatus.scheduler_extra_jobs_loaded : "--"],
    ["Last checked", dateTimeText(ownerStatus.last_checked_at || data.generatedAt)],
  ], controllerLevel);

  const network = getNetworkStatus(data);
  setTile(els.networkTile, network.level, els.networkTileValue, els.networkTileDetail, network.value, network.detail);
  setInteractiveDetail(els.networkTile, "Ethernet Health", [
    ["Status", network.value],
    ["Detail", network.detail],
    ["Ethernet IP", ownerStatus.ethernet_ip || ethernetSample(data).ip || "--"],
    ["Gateway ping", ownerStatus.gateway_ping_ms !== undefined && ownerStatus.gateway_ping_ms !== null ? `${ownerStatus.gateway_ping_ms} ms` : "--"],
    ["Local API", ownerStatus.api_status || "--"],
    ["Public URL", ownerStatus.public_url_reachable === false ? "check" : "reachable"],
  ], network.level);

  const power = getPowerStatus(data);
  setTile(els.hardwareTile, power.level, els.hardwareTileValue, els.hardwareTileDetail, power.value, power.detail);
  setInteractiveDetail(els.hardwareTile, "Controller Power", [
    ["CPU temperature", ownerStatus.cpu_temp_c !== null && ownerStatus.cpu_temp_c !== undefined ? `${ownerStatus.cpu_temp_c} C` : power.value],
    ["Current undervoltage", ownerStatus.undervoltage_current ? "YES" : "no"],
    ["Undervoltage since boot", ownerStatus.undervoltage_occurred === undefined ? "--" : ownerStatus.undervoltage_occurred ? "YES" : "no"],
    ["Power suspected", ownerStatus.power_suspected ? "YES" : "no"],
    ["Current uptime", compactDurationSeconds(ownerStatus.current_uptime_seconds)],
    ["Restarts last 24h", ownerStatus.restart_count_last_24h !== undefined ? ownerStatus.restart_count_last_24h : "--"],
    ["Last restart", dateTimeText(ownerStatus.last_restart_at)],
    ["Detail", power.detail],
    ["Last checked", dateTimeText(ownerStatus.last_checked_at || data.generatedAt)],
  ], power.level);

  const sensors = getSensorStatus(data);
  setTile(els.mapTile, sensors.level, els.mapTileValue, els.mapTileDetail, sensors.value, sensors.detail);
  setInteractiveDetail(els.mapTile, "Sensor Health", [
    ["Status", sensors.value],
    ["Current sensors", ownerStatus.sensors_current !== undefined ? ownerStatus.sensors_current : "--"],
    ["Expected sensors", ownerStatus.sensors_expected !== undefined ? ownerStatus.sensors_expected : "--"],
    ["Not updating", ownerStatus.sensors_stale !== undefined ? ownerStatus.sensors_stale : "--"],
    ["No stored reading", ownerStatus.sensors_missing !== undefined ? ownerStatus.sensors_missing : "--"],
    ["Missing sensors", (ownerStatus.missing_sensors || []).join(", ") || "--"],
    ["Config warnings", (ownerStatus.config_warnings || []).join(", ") || "--"],
    ["Calibration warnings", (ownerStatus.calibration_warnings || []).join(", ") || "--"],
    ["Watering disabled", (ownerStatus.watering_disabled || []).join(", ") || "--"],
  ], sensors.level);
}

function schedulerDiagnostic(data) {
  const ownerStatus = getOwnerStatus(data);
  const diagnostics = ownerStatus.diagnostics || {};
  const schedulerDiag = diagnostics.scheduler || {};
  const scheduler = data.scheduler || {};
  const counts = schedulerDiag.counts || scheduler.counts || {};
  const rows = sensorRows(data);
  const expected = ownerStatus.scheduler_expected_matt_jobs !== undefined
    ? ownerStatus.scheduler_expected_matt_jobs
    : schedulerDiag.expectedMattJobs !== undefined
      ? schedulerDiag.expectedMattJobs
      : rows.length;
  const loaded = ownerStatus.scheduler_jobs_loaded !== undefined
    ? ownerStatus.scheduler_jobs_loaded
    : schedulerDiag.jobsLoaded !== undefined
      ? schedulerDiag.jobsLoaded
      : scheduler.totalPending;
  const extra = ownerStatus.scheduler_extra_jobs_loaded !== undefined
    ? ownerStatus.scheduler_extra_jobs_loaded
    : schedulerDiag.extraJobsLoaded !== undefined
      ? schedulerDiag.extraJobsLoaded
      : loaded !== undefined && expected !== undefined
        ? Math.max(0, loaded - expected)
        : null;
  return {
    available: scheduler.available !== false,
    source: schedulerDiag.source || scheduler.source || "--",
    counts,
    expected,
    loaded,
    extra,
    overloaded: Boolean(ownerStatus.scheduler_overloaded || schedulerDiag.overloaded || extra > 0),
  };
}

function throttleFlagsText(ownerStatus) {
  const flags = ownerStatus.throttled_flags || {};
  if (Array.isArray(flags.flags) && flags.flags.length) return flags.flags.join(", ");
  if (flags.raw) return `raw ${flags.raw}`;
  return "--";
}

function lastMattReadText(rows) {
  const latest = latestStoredReading(rows);
  return latest ? `${dateTimeText(latest)} (${ageText(latest)})` : "--";
}

function classifyWateringEvents(events, mattPots) {
  let matt = 0;
  let nonMatt = 0;
  events.forEach((event) => {
    const pot = potNumberFromEvent(event);
    if (pot !== null && mattPots.has(pot)) matt += 1;
    else nonMatt += 1;
  });
  return { matt, nonMatt };
}

function updateHealthGraphs(data) {
  const ethernet = ethernetSample(data);
  const power = powerSample(data);
  const ownerStatus = getOwnerStatus(data);
  const rows = sensorRows(data);
  const allHistoryRecords = chartHistoryRecords(data);
  const historyRecords = filterRecordsForGraphWindow(allHistoryRecords);
  const visibleRange = graphVisibleRange(allHistoryRecords);
  const graphControls = renderGraphControls(allHistoryRecords);
  liveSamples = [...liveSamples, currentHistoryRecord(data)].slice(-LIVE_SAMPLE_LIMIT);

  const powerStatus = getPowerStatus(data);
  const powerLevel = powerStatus.level;
  setBadge(els.powerGraphBadge, powerLevel, powerStatus.value);
  els.powerGraphDetail.textContent = power.tempC !== null
    ? `${power.tempC.toFixed(1)} C now; undervoltage ${ownerStatus.undervoltage_current ? "on" : "off"}.`
    : "Power telemetry has not reported yet.";
  evidenceFacts(els.powerFacts, [
    ["CPU temp", power.tempC !== null ? `${power.tempC.toFixed(1)} C` : "--"],
    ["Current undervoltage", yesNo(ownerStatus.undervoltage_current)],
    ["Since boot", yesNo(ownerStatus.undervoltage_occurred)],
    ["Throttle flags", throttleFlagsText(ownerStatus)],
  ]);
  const tempPoints = historyRecords.map((record) => ({ t: record.t, value: record.cpuTempC }));
  const alarmPoints = historyRecords.map((record) => ({ t: record.t, value: record.undervoltageCurrent ? 85 : 0 }));
  const latchedPoints = historyRecords.map((record) => ({ t: record.t, value: record.undervoltageOccurred && !record.undervoltageCurrent ? 72 : 0 }));
  const restartPoints = historyRecords.map((record) => ({ t: record.t, value: finiteNumber(record.uptimeSeconds) !== null && finiteNumber(record.uptimeSeconds) < 90 ? 70 : 0 }));
  els.powerGraph.innerHTML = renderLineChart({
    series: [
      { label: "CPU temp", klass: "primary", points: tempPoints },
      { label: "Current undervoltage marker", klass: "danger", points: alarmPoints },
      { label: "Since boot marker", klass: "secondary", points: latchedPoints },
      { label: "Restart evidence", klass: "warning", points: restartPoints },
    ],
    yMin: 0,
    yMax: 85,
    unit: "C",
    yTitle: "Temperature C / flag marker",
    controlsHtml: graphControls,
  });

  const ethernetLevel = ethernet.up && ethernet.apiOk ? "ok" : ethernet.up ? "warning" : "critical";
  setBadge(els.ethernetGraphBadge, ethernetLevel, ethernet.up ? "Link up" : "Link down");
  const eth = data.piLocal && data.piLocal.available ? data.piLocal.ethernet || {} : data.confirmedPiEthernet || {};
  const ethernetSpeed = eth.speed ? `${eth.speed} Mbps${eth.duplex ? ` ${eth.duplex}` : ""}` : "";
  els.ethernetGraphDetail.textContent = ethernet.up
    ? `${ethernet.ip || "controller"} linked${ethernetSpeed ? `; ${ethernetSpeed}` : ""}.`
    : "Ethernet link is not currently confirmed.";
  evidenceFacts(els.connectivityFacts, [
    ["Ethernet link", ethernet.carrier ? "up" : "down/unknown"],
    ["Speed", eth.speed ? `${eth.speed} Mbps ${eth.duplex || ""}`.trim() : "--"],
    ["Gateway ping", ethernet.gatewayPingMs === null ? "--" : `${ethernet.gatewayPingMs} ms`],
  ]);
  els.ethernetGraph.innerHTML = renderLineChart({
    series: [
      { label: "Ethernet link", klass: "primary", points: historyRecords.map((record) => ({ t: record.t, value: record.ethUp ? 1 : 0 })) },
    ],
    yMin: 0,
    yMax: 1,
    yTitle: "Ethernet link",
    controlsHtml: graphControls,
  });

  const schedulerDiag = schedulerDiagnostic(data);
  const schedulerCounts = schedulerDiag.counts || {};
  const schedulerLevel = schedulerDiag.loaded === 0 ? "critical" : schedulerDiag.overloaded ? "warning" : schedulerDiag.loaded === undefined || schedulerDiag.loaded === null ? "neutral" : "ok";
  setBadge(els.schedulerGraphBadge, schedulerLevel, schedulerDiag.loaded === undefined || schedulerDiag.loaded === null ? "Unknown" : `${schedulerDiag.loaded} loaded`);
  els.schedulerGraphDetail.textContent = schedulerDiag.loaded === undefined || schedulerDiag.loaded === null
    ? "Queue counts are not available."
    : `${schedulerDiag.loaded}/${schedulerDiag.expected} jobs loaded; ${schedulerDiag.extra || 0} extra.`;
  evidenceFacts(els.schedulerFacts, [
    ["Jobs", schedulerDiag.loaded === undefined || schedulerDiag.loaded === null || schedulerDiag.expected === undefined || schedulerDiag.expected === null ? "--" : `${schedulerDiag.loaded}/${schedulerDiag.expected}`],
    ["Queue", `${schedulerCounts.wait || 0}/${schedulerCounts.active || 0}/${schedulerCounts.delayed || 0}`],
    ["Last Matt read", lastMattReadText(rows)],
  ]);
  els.schedulerGraph.innerHTML = "";

  const missing = rows.filter((row) => row.missing).length;
  const stale = rows.filter((row) => row.stale).length;
  const healthy = Math.max(0, rows.length - missing - stale);
  const sensorLevel = missing || stale ? "warning" : rows.length ? "ok" : "neutral";
  setBadge(els.sensorGraphBadge, sensorLevel, rows.length ? `${healthy}/${rows.length} OK` : "No rows");
  const latest = latestStoredReading(rows);
  els.sensorGraphDetail.textContent = rows.length
    ? `${healthy}/${rows.length} current; latest read ${dateTimeText(latest)} (${ageText(latest)}).`
    : "No sensor rows are loaded from the API.";
  evidenceFacts(els.sensorFacts, [
    ["Last Matt read", lastMattReadText(rows)],
    ["Current", rows.length ? `${healthy}/${rows.length}` : "--"],
    ["Stale/missing", rows.length ? `${stale + missing}` : "--"],
    ["Node2", sensorGroupSummary(rows, "Node2")],
    ["Node4", sensorGroupSummary(rows, "Node4")],
  ]);
  els.sensorGraph.innerHTML = renderLineChart({
    series: [
      { label: "Not updating or missing", klass: "warning", points: historyRecords.map((record) => ({ t: record.t, value: record.staleOrMissingSensors })) },
      { label: "Total mapped sensors", klass: "secondary", points: historyRecords.map((record) => ({ t: record.t, value: record.sensorRows })) },
    ],
    yMin: 0,
    yMax: Math.max(20, rows.length),
    yTitle: "Sensor count",
    controlsHtml: graphControls,
  });

  const watering = (data.api && data.api.watering) || {};
  const displayEvents = filterEventsForGraphWindow(wateringEventsForDisplay(watering), visibleRange);
  const disabledWatering = ownerStatus.watering_disabled || [];
  const waterLevel = displayEvents.length || watering.last24h ? "ok" : "neutral";
  setBadge(els.waterGraphBadge, waterLevel, `${watering.last24h || 0} / 24h`);
  els.waterGraphDetail.textContent = disabledWatering.length
    ? `Disabled: ${disabledWatering.join(", ")}. ${watering.last24h || 0} opens in 24h.`
    : `Watering enabled. ${watering.last24h || 0} opens in 24h.`;
  evidenceFacts(els.waterFacts, [
    ["24h opens", watering.last24h !== undefined ? watering.last24h : "--"],
    ["Watering disabled", disabledWatering.length ? disabledWatering.join(", ") : "none"],
  ]);
  els.waterGraph.innerHTML = renderWaterEventChart(displayEvents, historyRecords, graphControls);
}

function updateMattMap(data) {
  if (!els.mattMapBadge) return;
  const rows = sensorRows(data);
  const ownerStatus = getOwnerStatus(data);
  const missing = rows.filter((row) => row.missing).length;
  const stale = rows.filter((row) => row.stale).length;
  const warnings = (ownerStatus.config_warnings || []).length + (ownerStatus.calibration_warnings || []).length;
  const healthy = Math.max(0, rows.length - missing - stale);
  const level = missing ? "critical" : stale || warnings ? "warning" : rows.length ? "ok" : "neutral";
  setBadge(els.mattMapBadge, level, rows.length ? `${healthy}/${rows.length} current` : "No rows");
  els.mattMapDetail.textContent = rows.length
    ? `${healthy} current, ${stale} stale, ${missing} missing. Watering disabled: ${(ownerStatus.watering_disabled || []).join(", ") || "none"}.`
    : "No mapped Matt rows loaded.";
  renderPotMap(rows);
  renderMattSensorTable(rows);
}

function updateApiFacts(data) {
  const ownerStatus = getOwnerStatus(data);
  const apiOk = Boolean(data.api && data.api.healthcheck && data.api.healthcheck.ok);
  const scheduler = data.scheduler || {};
  const counts = scheduler.counts || {};
  const watering = (data.api && data.api.watering) || {};
  setBadge(els.apiBadge, apiOk ? "ok" : "critical", apiOk ? "Live" : "Down");
  els.apiFacts.innerHTML = facts([
    ["Owner status", ownerStatus.overall_status ? statusLabel(ownerStatus.overall_status) : "--"],
    ["Last checked", dateTimeText(ownerStatus.last_checked_at || data.generatedAt)],
    ["Last sensor reading", dateTimeText(ownerStatus.last_sensor_reading_at)],
    ["Last DB write", dateTimeText(ownerStatus.last_database_write_at)],
    ["Scheduler jobs", ownerStatus.scheduler_jobs_loaded !== undefined ? ownerStatus.scheduler_jobs_loaded : scheduler.available ? scheduler.totalPending : "--"],
    ["Expected Matt jobs", ownerStatus.scheduler_expected_matt_jobs !== undefined ? ownerStatus.scheduler_expected_matt_jobs : "--"],
    ["Extra scheduler jobs", ownerStatus.scheduler_extra_jobs_loaded !== undefined ? ownerStatus.scheduler_extra_jobs_loaded : "--"],
    ["Known issues", (ownerStatus.known_issues || []).length],
    ["System state", data.api && data.api.system && data.api.system.data && data.api.system.data.state],
    ["Pairings", data.api && data.api.pairings && data.api.pairings.count],
    ["Sensors", data.api && data.api.sensors && data.api.sensors.count],
    ["Scheduler", scheduler.available ? `${scheduler.totalPending} pending` : scheduler.error],
    ["Queue states", scheduler.available ? `wait ${counts.wait || 0}, active ${counts.active || 0}, delayed ${counts.delayed || 0}` : "--"],
    ["Water events", `${watering.eventsLoaded || 0} loaded${watering.source ? ` / ${watering.source}` : ""}`],
    ["History", data.historyMeta ? `${data.historyMeta.count} samples / ${data.historyMeta.retentionDays || HISTORY_DAYS} days` : "--"],
  ]);
}

function updateNetworkFacts(data) {
  const status = getNetworkStatus(data);
  const eth = data.piLocal && data.piLocal.available ? data.piLocal.ethernet || {} : data.confirmedPiEthernet || {};
  setBadge(els.networkBadge, status.level, status.value);
  els.networkFacts.innerHTML = facts([
    ["Device", eth.device || "eth0"],
    ["Carrier", eth.carrier === undefined ? (eth.linkDetected ? "true" : "--") : eth.carrier],
    ["IPv4", eth.ipv4],
    ["Gateway", eth.gateway],
    ["Gateway ping", eth.gatewayPingMs !== undefined && eth.gatewayPingMs !== null ? `${eth.gatewayPingMs} ms` : "--"],
    ["Local API", ethernetSample(data).apiOk ? "reachable" : "down"],
    ["Balena public URL", ethernetSample(data).publicOk ? "reachable" : "down"],
    ["External direct IP", "separate check; do not mix with cloud path"],
  ]);
}

function updatePiFacts(data) {
  const ownerStatus = getOwnerStatus(data);
  const pi = data.piLocal || {};
  const resources = pi.resources || {};
  const hardware = pi.hardware || {};
  const memory = resources.memory || {};
  const disk = resources.disk || {};
  const power = getPowerStatus(data);
  setBadge(els.piBadge, power.level, power.level === "ok" ? "Live" : "Check");
  els.piFacts.innerHTML = facts([
    ["CPU temp", resources.temperatureC !== undefined && resources.temperatureC !== null ? `${resources.temperatureC} C` : "--"],
    ["Current undervoltage", ownerStatus.undervoltage_current === undefined ? "--" : ownerStatus.undervoltage_current ? "YES" : "no"],
    ["Undervoltage since boot", ownerStatus.undervoltage_occurred === undefined ? "--" : ownerStatus.undervoltage_occurred ? "YES" : "no"],
    ["Power suspected", ownerStatus.power_suspected ? "YES" : "no"],
    ["Uptime", compactDurationSeconds(ownerStatus.current_uptime_seconds !== undefined ? ownerStatus.current_uptime_seconds : hardware.uptimeSeconds)],
    ["Restarts last 24h", ownerStatus.restart_count_last_24h !== undefined ? ownerStatus.restart_count_last_24h : "--"],
    ["Load", (resources.loadAverage || []).join(", ")],
    ["Memory used", memory.available ? `${memory.usedPercent}%` : "--"],
    ["Disk used", disk.usedPercent ? `${disk.usedPercent}%` : "--"],
  ]);
}

function updateBoards(data) {
  const boards = (data.api && data.api.boards) || {};
  const level = boards.ok ? "ok" : "critical";
  setBadge(els.boardsBadge, level, boards.ok ? "Configured" : "Missing");
  els.boardRow.innerHTML = (boards.expected || [])
    .map((board) => {
      const ok = (boards.actual || []).includes(board);
      return `<div class="board-pill ${ok ? "ok" : "critical"}"><strong>${escapeHtml(board)}</strong><span>${ok ? "present" : "missing"}</span></div>`;
    })
    .join("");
}

function updateDashboard(data) {
  lastDashboardData = data;
  els.timestamp.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
  updateSummary(data);
  updateTiles(data);
  updateRestartEvidence(data);
  updateHealthGraphs(data);
  updateApiFacts(data);
  updateNetworkFacts(data);
  updatePiFacts(data);
  updateBoards(data);
}

async function loadHealth() {
  els.refreshButton.disabled = true;
  els.refreshButton.textContent = "Checking";
  try {
    const [response, historyResponse] = await Promise.all([
      fetch(apiPath("/api/health"), { cache: "no-store" }),
      fetch(apiPath(`/api/history?days=${HISTORY_DAYS}`), { cache: "no-store" }).catch(() => null),
    ]);
    if (!response.ok) throw new Error(`Health endpoint returned HTTP ${response.status}`);
    const data = await response.json();
    if (historyResponse && historyResponse.ok) {
      const history = await historyResponse.json();
      persistedHistory = Array.isArray(history.records) ? history.records : [];
      data.historyRecords = persistedHistory;
      data.historyMeta = {
        days: history.days,
        retentionDays: history.retentionDays,
        sampleIntervalSeconds: history.sampleIntervalSeconds,
        count: history.count,
      };
    } else {
      data.historyRecords = persistedHistory.length ? persistedHistory : liveSamples;
    }
    updateDashboard(data);
  } catch (error) {
    els.summary.className = "summary critical";
    setBadge(els.summaryBadge, "critical", "Error");
    els.overallTitle.textContent = "Dashboard data connection failed";
    els.overallDetail.textContent = String(error.message || error);
  } finally {
    els.refreshButton.disabled = false;
    els.refreshButton.textContent = "Refresh";
  }
}

document.addEventListener("click", (event) => {
  const graphButton = event.target.closest("[data-graph-window-action]");
  if (graphButton) {
    const action = graphButton.dataset.graphWindowAction;
    if (action === "expand" && graphWindowPresetIndex < GRAPH_WINDOW_PRESETS.length - 1) {
      graphWindowPresetIndex += 1;
    } else if (action === "contract" && graphWindowPresetIndex > 0) {
      graphWindowPresetIndex -= 1;
    } else if (action === "reset") {
      graphWindowPresetIndex = 0;
    }
    if (lastDashboardData) updateDashboard(lastDashboardData);
    return;
  }

  const target = event.target.closest("[data-detail]");
  if (!target) return;
  try {
    showDetail(JSON.parse(target.dataset.detail || "{}"));
  } catch {
    return;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideDetail();
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target.closest("[data-detail]");
  if (!target) return;
  event.preventDefault();
  try {
    showDetail(JSON.parse(target.dataset.detail || "{}"));
  } catch {
    return;
  }
});

els.detailClose.addEventListener("click", hideDetail);
els.detailOverlay.addEventListener("click", hideDetail);
els.refreshButton.addEventListener("click", loadHealth);
loadHealth();
setInterval(loadHealth, 30000);

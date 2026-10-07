import { Loader2 } from "lucide-react";
import { type KeyboardEvent, memo, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { healthNumber } from "../healthValues";
import { formatDuration, formatMeasurementTime } from "../measurementFreshness";
import { plantGroupLabel, treatmentLabel } from "../portalPresentation";
import { type ChartSeries, type ChartTargetLine, type HealthWateringEvent, type TimeBounds, type TooltipState, type ViewMode, type WateringOverlayTooltip } from "../portalTypes";
import {
  decimateForDisplay,
  gapThresholdMs,
  lowerBound,
  nearestIndexByTime,
  observedCadenceMs,
  summarizeSeries,
} from "../seriesStatistics";
import { partitionOverlayMarkers } from "../wateringOverlay";
import { axisLabel, buildWateringOverlayMarkers, type ChartBounds, chartBounds, crispLine, formatAxisTick } from "./chartGeometry";

const noWateringEvents: HealthWateringEvent[] = [];
const noTargetLines: ChartTargetLine[] = [];
const targetColors: Record<ChartTargetLine["tone"], string> = {
  control: "#1d4ed8",
  drought: "#c2410c",
  neutral: "#334155",
};
const wateringColor = (series: ChartSeries) => (series.treatment === "drought" ? "#f97316" : "#2563eb");

type SensorCanvasChartProps = {
  series: ChartSeries[];
  visibleNames: Set<string>;
  selectedName: string | null;
  viewMode: ViewMode;
  onSelectSeries: (name: string) => void;
  loading: boolean;
  xDomain?: TimeBounds | null;
  wateringEvents?: HealthWateringEvent[];
  /** Overview cards: draw at the allocated size with smaller margins. */
  compact?: boolean;
  /** Horizontal reference lines, e.g. treatment targets. */
  targetLines?: ChartTargetLine[];
  /** Target text for a pot's tooltip, when one applies. */
  describeTarget?: (series: ChartSeries) => string | null;
  /** Extra space above the plot for an overlaid heading. */
  headerSpace?: number;
};

function SensorCanvasChartComponent({
  series,
  visibleNames,
  selectedName,
  viewMode,
  onSelectSeries,
  loading,
  xDomain = null,
  wateringEvents = noWateringEvents,
  compact = false,
  targetLines = noTargetLines,
  describeTarget,
  headerSpace = 0,
}: SensorCanvasChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const boundsRef = useRef<ChartBounds | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [wateringTooltip, setWateringTooltip] = useState<WateringOverlayTooltip | null>(null);
  const [lockedSeriesName, setLockedSeriesName] = useState<string | null>(null);

  const visibleSeries = useMemo(
    () => series.filter((item) => visibleNames.has(item.name) && item.points.length > 0),
    [series, visibleNames],
  );
  // Line breaks use the configured cadence, or the observed one when none is configured.
  const gapBySeries = useMemo(
    () => new Map(visibleSeries.map((item) => [
      item.name,
      gapThresholdMs(item.expectedIntervalMs ?? observedCadenceMs(item.points)),
    ])),
    [visibleSeries],
  );
  const targetValues = useMemo(() => targetLines.map((line) => line.value), [targetLines]);
  const allWateringMarkers = useMemo(
    () => buildWateringOverlayMarkers(wateringEvents, visibleSeries, xDomain),
    [visibleSeries, wateringEvents, xDomain],
  );
  const { visible: wateringMarkers, omittedCount: omittedWateringMarkerCount } = useMemo(
    () => partitionOverlayMarkers(allWateringMarkers),
    [allWateringMarkers],
  );
  const hasTreatments = useMemo(
    () => visibleSeries.some((item) => item.treatment === "drought") && visibleSeries.some((item) => item.treatment !== "drought"),
    [visibleSeries],
  );
  const hasGaps = useMemo(() => visibleSeries.some((item) => {
    const gap = gapBySeries.get(item.name) ?? Infinity;
    for (let index = 1; index < item.points.length; index += 1) {
      if (item.points[index].timestampMs - item.points[index - 1].timestampMs > gap) return true;
    }
    return false;
  }), [gapBySeries, visibleSeries]);

  useEffect(() => {
    if (tooltip && !visibleSeries.some((item) => item.name === tooltip.seriesName)) {
      setTooltip(null);
    }
    if (lockedSeriesName && !visibleSeries.some((item) => item.name === lockedSeriesName)) {
      setLockedSeriesName(null);
    }
  }, [lockedSeriesName, tooltip, visibleSeries]);

  useEffect(() => {
    if (!wateringEvents.length) setWateringTooltip(null);
  }, [wateringEvents.length]);

  useEffect(() => {
    if (!wateringTooltip) return;
    const stillVisible = wateringMarkers.some((marker) =>
      marker.timestampMs === wateringTooltip.timestampMs &&
      marker.series.name === wateringTooltip.series.name
    );
    if (!stillVisible) setWateringTooltip(null);
  }, [wateringMarkers, wateringTooltip]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return undefined;

    let animationFrame = 0;

    const draw = () => {
      const rect = wrapper.getBoundingClientRect();
      const width = Math.max(compact ? 120 : 320, rect.width);
      const height = Math.max(compact ? 80 : 360, rect.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);

      const bounds = chartBounds(visibleSeries, width, height, xDomain, targetValues, compact, headerSpace);
      boundsRef.current = bounds;
      const { margin, plotWidth, plotHeight, minX, maxX, spanX, xScale, yScale, yTicks } = bounds;

      context.save();
      const axisFont = compact ? "500 10px Inter, Arial, sans-serif" : "500 12px Inter, Arial, sans-serif";
      const axisColor = "#64748b";

      context.lineWidth = 1;
      context.fillStyle = axisColor;
      context.font = axisFont;
      context.textAlign = "right";
      context.textBaseline = "middle";

      context.setLineDash([]);
      context.strokeStyle = "#e7edf5";
      const tickStride = compact && yTicks.length > 5 ? 2 : 1;
      yTicks.forEach((tick, index) => {
        const y = crispLine(yScale(tick));
        context.beginPath();
        context.moveTo(margin.left, y);
        context.lineTo(margin.left + plotWidth, y);
        context.stroke();
        if (index % tickStride === 0) context.fillText(formatAxisTick(tick), margin.left - (compact ? 6 : 10), y);
      });

      // As many time labels as fit without touching: measured, not guessed from the width.
      const sampleLabel = axisLabel(maxX, spanX);
      const labelWidth = context.measureText(sampleLabel).width + (compact ? 16 : 28);
      const xTickCount = Math.max(1, Math.min(compact ? 2 : 5, Math.floor(plotWidth / labelWidth) - 1));
      context.textAlign = "center";
      context.textBaseline = "top";
      context.setLineDash([3, 6]);
      context.strokeStyle = "#edf2f7";
      for (let index = 0; index <= xTickCount; index += 1) {
        const timestamp = minX + (spanX * index) / xTickCount;
        const x = crispLine(xScale(timestamp));
        context.beginPath();
        context.moveTo(x, margin.top);
        context.lineTo(x, margin.top + plotHeight);
        context.stroke();
        context.textAlign = index === 0 ? "left" : index === xTickCount ? "right" : "center";
        context.fillText(axisLabel(timestamp, spanX), index === 0 ? margin.left : index === xTickCount ? margin.left + plotWidth : x, margin.top + plotHeight + (compact ? 6 : 12));
      }

      context.setLineDash([]);
      context.strokeStyle = "#a8b3c3";
      context.beginPath();
      context.moveTo(crispLine(margin.left), margin.top);
      context.lineTo(crispLine(margin.left), margin.top + plotHeight);
      context.lineTo(margin.left + plotWidth, crispLine(margin.top + plotHeight));
      context.stroke();

      if (!compact) {
        context.save();
        context.translate(18, margin.top + plotHeight / 2);
        context.rotate(-Math.PI / 2);
        context.fillStyle = axisColor;
        context.font = axisFont;
        context.textAlign = "center";
        context.fillText("VWC (%)", 0, 0);
        context.restore();
      }

      context.beginPath();
      context.rect(margin.left, margin.top, plotWidth, plotHeight);
      context.clip();

      // Targets are reference lines, labelled in text so colour is never the only cue.
      // Lines sit beneath the readings; their labels are drawn last so markers never hide them.
      const sortedTargets = targetLines.slice().sort((a, b) => b.value - a.value);
      for (const line of sortedTargets) {
        const y = crispLine(yScale(line.value));
        context.save();
        context.setLineDash([5, 4]);
        context.lineWidth = 1.4;
        context.strokeStyle = targetColors[line.tone];
        context.globalAlpha = 0.85;
        context.beginPath();
        context.moveTo(margin.left, y);
        context.lineTo(margin.left + plotWidth, y);
        context.stroke();
        context.restore();
      }

      const visiblePotLineCount = visibleSeries.filter((item) => item.kind === "pot").length;
      const isFocusedComparison = visiblePotLineCount > 1 && visiblePotLineCount <= 6;
      const buckets = Math.max(40, Math.round(plotWidth));

      for (const item of visibleSeries) {
        const selected = selectedName === item.name;
        const isSummary = item.kind === "group";
        // QC emphasis is only computed in the QC view; it never runs on every draw.
        const isQcWarning = viewMode === "qc" && (() => {
          const summary = summarizeSeries(item.points, { configuredIntervalMs: item.expectedIntervalMs });
          return summary.sharpDrops.count > 0 || summary.gaps.count > 0 || (summary.latest?.value ?? 100) < 8;
        })();
        context.globalAlpha =
          selected ? 1 :
          isSummary ? (viewMode === "individual" ? 0.85 : 0.95) :
          viewMode === "group" ? 0.2 :
          viewMode === "qc" ? (isQcWarning ? 0.9 : 0.12) :
          isFocusedComparison ? 0.92 :
          0.84;
        context.setLineDash(item.treatment === "drought" ? [7, 5] : []);
        context.strokeStyle = item.color;
        context.fillStyle = item.color;
        context.lineWidth =
          selected ? (isFocusedComparison ? 3.2 : 2.4) :
          isSummary ? 3.2 :
          viewMode === "qc" && isQcWarning ? 2.8 :
          isFocusedComparison ? 2.25 :
          compact ? 1.5 :
          1.85;
        context.lineJoin = "round";
        context.lineCap = "round";

        // Draw only the visible window plus one neighbour each side, reduced per pixel column
        // with extremes kept, and broken wherever readings stopped for longer than the cadence allows.
        const from = Math.max(0, lowerBound(item.points, minX) - 1);
        let to = lowerBound(item.points, maxX);
        while (to < item.points.length && item.points[to].timestampMs <= maxX) to += 1;
        const segments = decimateForDisplay(item.points.slice(from, Math.min(item.points.length, to + 1)), {
          startMs: minX,
          endMs: maxX,
          buckets,
          gapMs: gapBySeries.get(item.name) ?? gapThresholdMs(null),
        });
        for (const segment of segments) {
          if (segment.length === 1) {
            context.beginPath();
            context.arc(xScale(segment[0].timestampMs), yScale(segment[0].value), Math.max(1.6, context.lineWidth * 0.75), 0, Math.PI * 2);
            context.fill();
            continue;
          }
          context.beginPath();
          segment.forEach((point, index) => {
            const x = xScale(point.timestampMs);
            const y = yScale(point.value);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          context.stroke();
        }
        context.setLineDash([]);
        context.globalAlpha = 1;

        const latest = item.points[item.points.length - 1];
        if (latest.timestampMs >= minX && latest.timestampMs <= maxX) {
          context.beginPath();
          context.arc(
            xScale(latest.timestampMs),
            yScale(latest.value),
            selected || isSummary ? 4 : compact ? 2.2 : 2.8,
            0,
            Math.PI * 2,
          );
          context.fill();
        }
      }

      for (const marker of wateringMarkers) {
        const x = xScale(marker.timestampMs);
        const y = yScale(marker.value);
        const selected = selectedName === marker.series.name;
        const markerColor = wateringColor(marker.series);
        context.globalAlpha = selected || visiblePotLineCount <= 6 ? 0.98 : 0.72;
        context.setLineDash([]);
        context.strokeStyle = markerColor;
        context.fillStyle = "rgba(255, 255, 255, 0.96)";
        context.lineWidth = selected ? 2.8 : 2.2;
        context.beginPath();
        context.arc(x, y, selected ? 5.2 : 4.4, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.beginPath();
        context.moveTo(x, y - (selected ? 6.5 : 5.7));
        context.lineTo(x, y - (selected ? 10 : 8.7));
        context.stroke();
        context.globalAlpha = 1;
      }

      let previousLabelY = -Infinity;
      for (const line of sortedTargets) {
        const y = crispLine(yScale(line.value));
        const color = targetColors[line.tone];
        context.save();
        context.font = compact ? "600 10px Inter, Arial, sans-serif" : "600 11px Inter, Arial, sans-serif";
        const text = line.label;
        const textWidth = context.measureText(text).width;
        let labelY = y - (compact ? 8 : 9);
        if (labelY - previousLabelY < (compact ? 13 : 15)) labelY = previousLabelY + (compact ? 13 : 15);
        previousLabelY = labelY;
        const labelX = margin.left + plotWidth - textWidth - 8;
        context.fillStyle = "rgba(255, 255, 255, 0.94)";
        context.fillRect(labelX - 4, labelY - 7, textWidth + 8, compact ? 13 : 15);
        context.fillStyle = color;
        context.textAlign = "left";
        context.textBaseline = "middle";
        context.fillText(text, labelX, labelY);
        context.restore();
      }

      context.restore();
    };

    const scheduleDraw = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(wrapper);
    scheduleDraw();

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, [compact, gapBySeries, headerSpace, selectedName, targetLines, targetValues, viewMode, visibleSeries, wateringMarkers, xDomain]);

  function plotPosition(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    const bounds = boundsRef.current;
    if (!canvas || !bounds) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { margin, plotWidth, plotHeight } = bounds;
    if (x < margin.left || x > margin.left + plotWidth || y < margin.top || y > margin.top + plotHeight) return null;
    return { x, y, bounds };
  }

  function tooltipFor(item: ChartSeries, index: number, bounds: ChartBounds, locked = false): TooltipState {
    const point = item.points[index];
    return {
      x: bounds.xScale(point.timestampMs),
      y: bounds.yScale(point.value),
      seriesName: item.name,
      seriesKind: item.kind,
      color: item.color,
      zone: item.zone,
      potNumber: item.potNumber,
      plantGroup: item.plantGroup,
      treatment: item.treatment,
      point,
      locked,
    };
  }

  // Nearest point by binary search on time, then a short scan outwards; never a full pass over every reading.
  function nearestAt(event: MouseEvent<HTMLCanvasElement>) {
    const position = plotPosition(event.clientX, event.clientY);
    if (!position) return null;
    const { x, y, bounds } = position;
    const time = bounds.timeAt(x);
    let nearest: { item: ChartSeries; index: number } | null = null;
    let nearestDistance = Infinity;

    for (const item of visibleSeries) {
      const center = nearestIndexByTime(item.points, time);
      if (center < 0) continue;
      for (const direction of [-1, 1]) {
        for (let index = direction < 0 ? center : center + 1; index >= 0 && index < item.points.length; index += direction) {
          const point = item.points[index];
          const dx = Math.abs(bounds.xScale(point.timestampMs) - x) * 1.4;
          if (dx >= nearestDistance || dx > 48) break;
          const distance = dx + Math.abs(bounds.yScale(point.value) - y);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = { item, index };
          }
        }
      }
    }

    return nearest && nearestDistance < 48 ? tooltipFor(nearest.item, nearest.index, bounds) : null;
  }

  function nearestWateringAt(event: MouseEvent<HTMLCanvasElement>): WateringOverlayTooltip | null {
    if (!wateringMarkers.length) return null;
    const position = plotPosition(event.clientX, event.clientY);
    if (!position) return null;
    const { x: mouseX, y: mouseY, bounds } = position;
    let nearest: WateringOverlayTooltip | null = null;
    let nearestDistance = Infinity;
    for (const marker of wateringMarkers) {
      const x = bounds.xScale(marker.timestampMs);
      const y = bounds.yScale(marker.value);
      const distance = Math.hypot(x - mouseX, y - mouseY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = { ...marker, x, y };
      }
    }
    return nearestDistance <= 14 ? nearest : null;
  }

  function pointOnSeriesAtX(event: MouseEvent<HTMLCanvasElement>, seriesName: string) {
    const item = visibleSeries.find((seriesItem) => seriesItem.name === seriesName);
    if (!item || item.points.length === 0) return null;
    const position = plotPosition(event.clientX, event.clientY);
    if (!position) return null;
    const index = nearestIndexByTime(item.points, position.bounds.timeAt(position.x));
    return index < 0 ? null : tooltipFor(item, index, position.bounds, true);
  }

  function updateTooltip(event: MouseEvent<HTMLCanvasElement>) {
    if (compact || wateringTooltip?.locked) return;
    const watering = nearestWateringAt(event);
    if (watering) {
      setWateringTooltip(watering);
      setTooltip(null);
      return;
    }
    setWateringTooltip(null);
    if (lockedSeriesName) {
      setTooltip(pointOnSeriesAtX(event, lockedSeriesName));
      return;
    }
    setTooltip(nearestAt(event));
  }

  function selectNearest(event: MouseEvent<HTMLCanvasElement>) {
    if (compact) return;
    const watering = nearestWateringAt(event);
    if (watering) {
      setLockedSeriesName(watering.series.name);
      onSelectSeries(watering.series.name);
      setTooltip(null);
      setWateringTooltip({ ...watering, locked: true });
      return;
    }
    const nearest = nearestAt(event);
    if (nearest?.seriesKind === "pot") {
      setLockedSeriesName(nearest.seriesName);
      onSelectSeries(nearest.seriesName);
      setTooltip(pointOnSeriesAtX(event, nearest.seriesName) ?? nearest);
      setWateringTooltip(null);
      return;
    }
    setLockedSeriesName(null);
    setTooltip(null);
    setWateringTooltip(null);
  }

  // Keyboard reading: arrows step through the selected pot's readings (Shift moves ten).
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (compact || !visibleSeries.length) return;
    const bounds = boundsRef.current;
    if (!bounds) return;
    if (event.key === "Escape") {
      setLockedSeriesName(null);
      setTooltip(null);
      setWateringTooltip(null);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const item = visibleSeries.find((seriesItem) => seriesItem.name === (lockedSeriesName ?? tooltip?.seriesName ?? selectedName))
      ?? visibleSeries[0];
    const firstVisible = Math.max(0, lowerBound(item.points, bounds.minX));
    let lastVisible = lowerBound(item.points, bounds.maxX);
    while (lastVisible < item.points.length && item.points[lastVisible].timestampMs <= bounds.maxX) lastVisible += 1;
    lastVisible = Math.max(firstVisible, Math.min(item.points.length - 1, lastVisible - 1));
    const current = tooltip && tooltip.seriesName === item.name
      ? nearestIndexByTime(item.points, tooltip.point.timestampMs)
      : lastVisible;
    const step = event.shiftKey ? 10 : 1;
    const next =
      event.key === "Home" ? firstVisible :
      event.key === "End" ? lastVisible :
      event.key === "ArrowLeft" ? Math.max(firstVisible, current - step) :
      Math.min(lastVisible, current + step);
    setWateringTooltip(null);
    setLockedSeriesName(item.name);
    setTooltip(tooltipFor(item, next, bounds, true));
  }

  const tooltipSeries = tooltip ? visibleSeries.find((item) => item.name === tooltip.seriesName) ?? null : null;
  const tooltipTarget = tooltipSeries && describeTarget ? describeTarget(tooltipSeries) : null;
  const tooltipGapBefore = (() => {
    if (!tooltip || !tooltipSeries) return null;
    const index = nearestIndexByTime(tooltipSeries.points, tooltip.point.timestampMs);
    if (index <= 0) return null;
    const gap = tooltip.point.timestampMs - tooltipSeries.points[index - 1].timestampMs;
    return gap > (gapBySeries.get(tooltipSeries.name) ?? Infinity) ? gap : null;
  })();
  const wrapperWidth = wrapperRef.current?.clientWidth ?? 960;
  const wrapperHeight = wrapperRef.current?.clientHeight ?? 560;
  const potCount = visibleSeries.filter((item) => item.kind === "pot").length;
  const chartLabel = `${wateringEvents.length ? "Soil moisture with watering events" : "Soil moisture"} (VWC %) for ${potCount} ${potCount === 1 ? "pot" : "pots"}${targetLines.length ? `; ${targetLines.map((line) => line.label).join(", ")}` : ""}.${compact ? "" : " Use the arrow keys to step through readings."}`;

  return (
    <div
      ref={wrapperRef}
      className={`canvas-chart ${compact ? "is-compact" : ""}`}
      tabIndex={compact ? undefined : 0}
      role={compact ? undefined : "group"}
      aria-label={compact ? undefined : chartLabel}
      onKeyDown={handleKeyDown}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={updateTooltip}
        onClick={selectNearest}
        onMouseLeave={() => {
          if (!lockedSeriesName) {
            setTooltip(null);
            setWateringTooltip(null);
          }
        }}
        role={compact ? "img" : undefined}
        aria-label={compact ? chartLabel : undefined}
        aria-hidden={compact ? undefined : true}
      />
      {!compact && (hasTreatments || hasGaps) ? (
        <div className="chart-key" aria-hidden="true">
          {hasTreatments ? <span><i className="is-solid" />Control</span> : null}
          {hasTreatments ? <span><i className="is-dashed" />Drought</span> : null}
          {hasGaps ? <span><i className="is-break" />Line break = no readings</span> : null}
        </div>
      ) : null}
      {wateringEvents.length ? (
        <div className="watering-overlay-legend" aria-label="Watering overlay legend">
          <span><i />Water event</span>
          <span>{wateringMarkers.length} shown</span>
          {omittedWateringMarkerCount > 0 ? (
            <span className="is-omitted">
              {omittedWateringMarkerCount} water {omittedWateringMarkerCount === 1 ? "event" : "events"} omitted—no nearby VWC sample
            </span>
          ) : null}
        </div>
      ) : null}
      {loading ? (
        <div className="chart-loading-overlay" aria-label="Loading readings" aria-live="polite">
          <Loader2 className="chart-loading-spinner" size={compact ? 22 : 34} aria-hidden="true" />
        </div>
      ) : null}
      {!loading && !visibleSeries.length ? (
        <div className="chart-empty-state" role="status">No readings in this time range</div>
      ) : null}
      {wateringTooltip ? (
        <>
          <div
            className="chart-crosshair is-watering"
            style={{
              left: wateringTooltip.x,
              backgroundColor: wateringColor(wateringTooltip.series),
            }}
          />
          <div
            className={`chart-tooltip is-watering ${wateringTooltip.locked ? "is-locked" : ""}`}
            aria-live={wateringTooltip.locked ? "polite" : undefined}
            style={{
              left: Math.min(Math.max(wateringTooltip.x + 14, 10), Math.max(10, wrapperWidth - 235)),
              top: Math.min(Math.max(wateringTooltip.y - 98, 10), Math.max(10, wrapperHeight - 164)),
              borderColor: wateringColor(wateringTooltip.series),
            }}
          >
            <strong>Pot {wateringTooltip.series.potNumber}: valve opened</strong>
            <span>{formatMeasurementTime(wateringTooltip.timestampMs)}</span>
            <span>{healthNumber(wateringTooltip.event.valveOpenTimeMs) == null
              ? "Duration not reported"
              : `Open ${Math.round(healthNumber(wateringTooltip.event.valveOpenTimeMs) as number) / 1000} sec (controller record)`}</span>
            {wateringTooltip.value == null ? (
              <b>VWC unavailable near event</b>
            ) : (
              <b>{wateringTooltip.value.toFixed(1)}% VWC {wateringTooltip.exactValue ? "measured" : "interpolated"}</b>
            )}
            {wateringTooltip.before && wateringTooltip.after && !wateringTooltip.exactValue ? (
              <small>
                Between readings at {formatMeasurementTime(wateringTooltip.before.timestampMs)} ({wateringTooltip.before.value.toFixed(1)}%) and {formatMeasurementTime(wateringTooltip.after.timestampMs)} ({wateringTooltip.after.value.toFixed(1)}%)
              </small>
            ) : null}
          </div>
          <div
            className="chart-lock-dot is-watering"
            style={{
              left: wateringTooltip.x,
              top: wateringTooltip.y,
              borderColor: wateringColor(wateringTooltip.series),
            }}
          />
        </>
      ) : tooltip ? (
        <>
          {tooltip.locked ? (
            <div
              className="chart-crosshair"
              style={{ left: tooltip.x, backgroundColor: tooltip.color }}
            />
          ) : null}
          <div
            className={`chart-tooltip ${tooltip.locked ? "is-locked" : ""}`}
            aria-live={tooltip.locked ? "polite" : undefined}
            style={{
              left: Math.min(Math.max(tooltip.x + 14, 10), Math.max(10, wrapperWidth - 225)),
              top: Math.min(Math.max(tooltip.y - 72, 10), Math.max(10, wrapperHeight - 150)),
              borderColor: tooltip.color,
            }}
          >
            <strong>
              {tooltip.seriesKind === "pot"
                ? `Pot ${tooltip.potNumber}`
                : `${plantGroupLabel(tooltip.plantGroup)} ${treatmentLabel(tooltip.treatment)}`}
            </strong>
            <span>{formatMeasurementTime(tooltip.point.timestampMs)}</span>
            {tooltip.treatment !== "unknown" || tooltip.plantGroup !== "unknown" ? (
              <span>
                {plantGroupLabel(tooltip.plantGroup)} / {treatmentLabel(tooltip.treatment)}
                {tooltip.seriesKind === "pot" ? "" : " median"}
              </span>
            ) : null}
            <b>{tooltip.point.value.toFixed(1)}% VWC</b>
            {tooltipTarget ? <span>{tooltipTarget}</span> : null}
            {tooltipGapBefore ? <small>No readings for {formatDuration(tooltipGapBefore)} before this one</small> : null}
          </div>
          {tooltip.locked ? (
            <div
              className="chart-lock-dot"
              style={{
                left: tooltip.x,
                top: tooltip.y,
                borderColor: tooltip.color,
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export const SensorCanvasChart = memo(SensorCanvasChartComponent);

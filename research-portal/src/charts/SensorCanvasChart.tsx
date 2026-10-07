import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { healthNumber } from "../healthValues";
import { formatDateTime } from "../portalFormat";
import { plantGroupLabel, treatmentLabel } from "../portalPresentation";
import { type ChartSeries, type HealthWateringEvent, type TimeBounds, type TooltipState, type ViewMode, type WateringOverlayTooltip } from "../portalTypes";
import { partitionOverlayMarkers } from "../wateringOverlay";
import { axisLabel, buildWateringOverlayMarkers, chartBounds, crispLine, formatAxisTick } from "./chartGeometry";
import { statsForSeries } from "./chartSeries";

export function SensorCanvasChart({
  series,
  visibleNames,
  selectedName,
  viewMode,
  onSelectSeries,
  loading,
  xDomain = null,
  wateringEvents = [],
}: {
  series: ChartSeries[];
  visibleNames: Set<string>;
  selectedName: string | null;
  viewMode: ViewMode;
  onSelectSeries: (name: string) => void;
  loading: boolean;
  xDomain?: TimeBounds | null;
  wateringEvents?: HealthWateringEvent[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [wateringTooltip, setWateringTooltip] = useState<WateringOverlayTooltip | null>(null);
  const [lockedSeriesName, setLockedSeriesName] = useState<string | null>(null);

  const visibleSeries = useMemo(
    () => series.filter((item) => visibleNames.has(item.name) && item.points.length > 0),
    [series, visibleNames],
  );
  const allWateringMarkers = useMemo(
    () => buildWateringOverlayMarkers(wateringEvents, visibleSeries, xDomain),
    [visibleSeries, wateringEvents, xDomain],
  );
  const { visible: wateringMarkers, omittedCount: omittedWateringMarkerCount } = useMemo(
    () => partitionOverlayMarkers(allWateringMarkers),
    [allWateringMarkers],
  );

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
      const width = Math.max(320, rect.width);
      const height = Math.max(360, rect.height);
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

      const bounds = chartBounds(visibleSeries, width, height, xDomain);
      const { margin, plotWidth, plotHeight, minX, spanX, xScale, yScale, yTicks } = bounds;

      context.save();
      const axisFont = "500 12px Inter, Arial, sans-serif";
      const axisColor = "#64748b";

      context.lineWidth = 1;
      context.fillStyle = axisColor;
      context.font = axisFont;
      context.textAlign = "right";
      context.textBaseline = "middle";

      context.setLineDash([]);
      context.strokeStyle = "#e7edf5";
      for (const tick of yTicks) {
        const y = crispLine(yScale(tick));
        context.beginPath();
        context.moveTo(margin.left, y);
        context.lineTo(margin.left + plotWidth, y);
        context.stroke();
        context.fillText(formatAxisTick(tick), margin.left - 10, y);
      }

      const xTickCount = width < 720 ? 4 : 5;
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
        context.fillText(axisLabel(timestamp, spanX), x, margin.top + plotHeight + 12);
      }

      context.setLineDash([]);
      context.strokeStyle = "#a8b3c3";
      context.beginPath();
      context.moveTo(crispLine(margin.left), margin.top);
      context.lineTo(crispLine(margin.left), margin.top + plotHeight);
      context.lineTo(margin.left + plotWidth, crispLine(margin.top + plotHeight));
      context.stroke();

      context.save();
      context.translate(18, margin.top + plotHeight / 2);
      context.rotate(-Math.PI / 2);
      context.fillStyle = axisColor;
      context.font = axisFont;
      context.textAlign = "center";
      context.fillText("VWC (%)", 0, 0);
      context.restore();

      context.beginPath();
      context.rect(margin.left, margin.top, plotWidth, plotHeight);
      context.clip();

      const visiblePotLineCount = visibleSeries.filter((item) => item.kind === "pot").length;
      const isFocusedComparison = visiblePotLineCount > 1 && visiblePotLineCount <= 6;

      for (const item of visibleSeries) {
        if (item.points.length < 2) continue;
        const selected = selectedName === item.name;
        const isSummary = item.kind === "group";
        const isQcWarning = statsForSeries(item).status === "warning";
        context.globalAlpha =
          selected ? 1 :
          isSummary ? (viewMode === "individual" ? 0.85 : 0.95) :
          viewMode === "group" ? 0.2 :
          viewMode === "qc" ? (isQcWarning ? 0.9 : 0.12) :
          isFocusedComparison ? 0.92 :
          0.84;
        context.setLineDash(item.treatment === "drought" ? [7, 5] : []);
        context.strokeStyle = item.color;
        context.lineWidth =
          selected ? (isFocusedComparison ? 3.2 : 2.4) :
          isSummary ? 3.2 :
          viewMode === "qc" && isQcWarning ? 2.8 :
          isFocusedComparison ? 2.25 :
          1.85;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.beginPath();
        item.points.forEach((point, index) => {
          const x = xScale(point.timestampMs);
          const y = yScale(point.value);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
        context.setLineDash([]);
        context.globalAlpha = 1;

        const latest = item.points[item.points.length - 1];
        context.fillStyle = item.color;
        context.beginPath();
        context.arc(
          xScale(latest.timestampMs),
          yScale(latest.value),
          selected || isSummary ? 4 : 2.8,
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      for (const marker of wateringMarkers) {
        const x = xScale(marker.timestampMs);
        const y = yScale(marker.value);
        const selected = selectedName === marker.series.name;
        const markerColor = marker.series.treatment === "drought" ? "#f97316" : "#2563eb";
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
  }, [visibleSeries, selectedName, viewMode, wateringMarkers, xDomain]);

  function nearestAt(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const bounds = chartBounds(visibleSeries, rect.width, rect.height, xDomain);
    const { margin, plotWidth, plotHeight, xScale, yScale } = bounds;

    if (
      x < margin.left ||
      x > margin.left + plotWidth ||
      y < margin.top ||
      y > margin.top + plotHeight
    ) {
      return null;
    }

    let nearest: TooltipState | null = null;
    let nearestDistance = Infinity;

    for (const item of visibleSeries) {
      for (const point of item.points) {
        const pointX = xScale(point.timestampMs);
        const pointY = yScale(point.value);
        const distance = Math.abs(pointX - x) * 1.4 + Math.abs(pointY - y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = {
            x: pointX,
            y: pointY,
            seriesName: item.name,
            seriesKind: item.kind,
            color: item.color,
            zone: item.zone,
            potNumber: item.potNumber,
            plantGroup: item.plantGroup,
            treatment: item.treatment,
            point,
          };
        }
      }
    }

    return nearest && nearestDistance < 48 ? nearest : null;
  }

  function nearestWateringAt(
    event: React.MouseEvent<HTMLCanvasElement>,
  ): WateringOverlayTooltip | null {
    const canvas = canvasRef.current;
    if (!canvas || !wateringMarkers.length) return null;
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const bounds = chartBounds(visibleSeries, rect.width, rect.height, xDomain);
    const { margin, plotWidth, plotHeight, xScale, yScale } = bounds;
    if (
      mouseX < margin.left ||
      mouseX > margin.left + plotWidth ||
      mouseY < margin.top ||
      mouseY > margin.top + plotHeight
    ) {
      return null;
    }

    let nearest: WateringOverlayTooltip | null = null;
    let nearestDistance = Infinity;
    for (const marker of wateringMarkers) {
      const x = xScale(marker.timestampMs);
      const y = yScale(marker.value);
      const distance = Math.hypot(x - mouseX, y - mouseY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = { ...marker, x, y };
      }
    }
    return nearestDistance <= 14 ? nearest : null;
  }

  function pointOnSeriesAtX(event: React.MouseEvent<HTMLCanvasElement>, seriesName: string) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const item = visibleSeries.find((seriesItem) => seriesItem.name === seriesName);
    if (!item || item.points.length === 0) return null;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const bounds = chartBounds(visibleSeries, rect.width, rect.height, xDomain);
    const { margin, plotWidth, plotHeight, xScale, yScale } = bounds;

    if (
      x < margin.left ||
      x > margin.left + plotWidth ||
      y < margin.top ||
      y > margin.top + plotHeight
    ) {
      return null;
    }

    let point = item.points[0];
    let nearestDistance = Infinity;
    for (const candidate of item.points) {
      const distance = Math.abs(xScale(candidate.timestampMs) - x);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        point = candidate;
      }
    }

    return {
      x: xScale(point.timestampMs),
      y: yScale(point.value),
      seriesName: item.name,
      seriesKind: item.kind,
      color: item.color,
      zone: item.zone,
      potNumber: item.potNumber,
      plantGroup: item.plantGroup,
      treatment: item.treatment,
      point,
      locked: true,
    } satisfies TooltipState;
  }

  function updateTooltip(event: React.MouseEvent<HTMLCanvasElement>) {
    if (wateringTooltip?.locked) return;
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

  function selectNearest(event: React.MouseEvent<HTMLCanvasElement>) {
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

  return (
    <div ref={wrapperRef} className="canvas-chart">
      <canvas
        ref={canvasRef}
        onMouseDown={selectNearest}
        onMouseMove={updateTooltip}
        onClick={selectNearest}
        onMouseLeave={() => {
          if (!lockedSeriesName) {
            setTooltip(null);
            setWateringTooltip(null);
          }
        }}
        aria-label={wateringEvents.length ? "VWC with watering events chart" : "Soil moisture chart"}
      />
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
          <Loader2 className="chart-loading-spinner" size={34} aria-hidden="true" />
        </div>
      ) : null}
      {wateringTooltip ? (
        <>
          <div
            className="chart-crosshair is-watering"
            style={{
              left: wateringTooltip.x,
              backgroundColor: wateringTooltip.series.treatment === "drought" ? "#f97316" : "#2563eb",
            }}
          />
          <div
            className={`chart-tooltip is-watering ${wateringTooltip.locked ? "is-locked" : ""}`}
            style={{
              left: Math.min(
                Math.max(wateringTooltip.x + 14, 10),
                Math.max(10, (wrapperRef.current?.clientWidth ?? 960) - 235),
              ),
              top: Math.min(
                Math.max(wateringTooltip.y - 98, 10),
                Math.max(10, (wrapperRef.current?.clientHeight ?? 560) - 164),
              ),
              borderColor: wateringTooltip.series.treatment === "drought" ? "#f97316" : "#2563eb",
            }}
          >
            <strong>Pot {wateringTooltip.series.potNumber} watered</strong>
            <span>{formatDateTime(wateringTooltip.timestampMs)}</span>
            <span>{healthNumber(wateringTooltip.event.valveOpenTimeMs) == null
              ? "Duration not reported"
              : `${Math.round(healthNumber(wateringTooltip.event.valveOpenTimeMs) as number) / 1000} sec`}</span>
            {wateringTooltip.value == null ? (
              <b>VWC unavailable near event</b>
            ) : (
              <b>{wateringTooltip.value.toFixed(1)}% VWC {wateringTooltip.exactValue ? "measured" : "on displayed line"}</b>
            )}
            {wateringTooltip.before && wateringTooltip.after && !wateringTooltip.exactValue ? (
              <small>
                Samples: {formatDateTime(wateringTooltip.before.timestampMs)} ({wateringTooltip.before.value.toFixed(1)}%) and {formatDateTime(wateringTooltip.after.timestampMs)} ({wateringTooltip.after.value.toFixed(1)}%)
              </small>
            ) : null}
          </div>
          <div
            className="chart-lock-dot is-watering"
            style={{
              left: wateringTooltip.x,
              top: wateringTooltip.y,
              borderColor: wateringTooltip.series.treatment === "drought" ? "#f97316" : "#2563eb",
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
            style={{
              left: Math.min(
                Math.max(tooltip.x + 14, 10),
                Math.max(10, (wrapperRef.current?.clientWidth ?? 960) - 205),
              ),
              top: Math.min(
                Math.max(tooltip.y - 72, 10),
                Math.max(10, (wrapperRef.current?.clientHeight ?? 560) - 112),
              ),
              borderColor: tooltip.color,
            }}
          >
            <strong>
              {tooltip.seriesKind === "pot"
                ? `Pot ${tooltip.potNumber}`
                : `${plantGroupLabel(tooltip.plantGroup)} ${treatmentLabel(tooltip.treatment)}`}
            </strong>
            <span>{formatDateTime(tooltip.point.timestampMs)}</span>
            {tooltip.seriesKind === "pot" ? (
              <span>{plantGroupLabel(tooltip.plantGroup)} / {treatmentLabel(tooltip.treatment)}</span>
            ) : (
              <span>{plantGroupLabel(tooltip.plantGroup)} / {treatmentLabel(tooltip.treatment)} median</span>
            )}
            <b>{tooltip.point.value.toFixed(1)}% VWC</b>
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

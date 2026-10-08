import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

export type TimedPoint = { timestampMs: number; value: number };
export type ChartLine = {
  id: string;
  label: string;
  color: string;
  dash?: string | null;
  width?: number;
  opacity?: number;
  /** Already split at gaps; never joined across a missing stretch. */
  segments: TimedPoint[][];
};
export type ChartBand = {
  id: string;
  color: string;
  opacity?: number;
  segments: { timestampMs: number; low: number; high: number }[][];
};
export type ChartTarget = { value: number; label: string; color: string; dash?: string };
export type ChartTick = { timestampMs: number };
export type ChartShade = { startMs: number; endMs: number; label: string };
export type ChartReadout = { title: string; rows: { label: string; value: string }[] };

export const chartMargin = { left: 44, right: 14, top: 10, bottom: 26 };

export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => setWidth(Math.round(element.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const hour = 3_600_000;
const tickSteps = [hour, 2 * hour, 3 * hour, 6 * hour, 12 * hour, 24 * hour, 48 * hour, 7 * 24 * hour, 14 * 24 * hour, 30 * 24 * hour];

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const hourFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric" });

function localMidnight(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Ticks at local clock boundaries, at least `minGapPx` apart. Midnights are labelled by date. */
export function timeTicks(domain: { startMs: number; endMs: number }, plotWidth: number, minGapPx = 74) {
  const span = Math.max(1, domain.endMs - domain.startMs);
  const step = tickSteps.find((candidate) => (candidate / span) * plotWidth >= minGapPx) ?? tickSteps[tickSteps.length - 1];
  const ticks: { at: number; label: string }[] = [];
  let at = step >= 24 * hour ? localMidnight(domain.startMs) : localMidnight(domain.startMs);
  while (at < domain.startMs) at += step >= 24 * hour ? 24 * hour : step;
  let guard = 0;
  while (at <= domain.endMs && guard < 400) {
    guard += 1;
    const midnight = new Date(at).getHours() === 0;
    ticks.push({ at, label: midnight || step >= 24 * hour ? dayFormat.format(at) : hourFormat.format(at) });
    if (step >= 24 * hour) {
      const date = new Date(at);
      date.setDate(date.getDate() + Math.round(step / (24 * hour)));
      at = date.getTime();
    } else at += step;
  }
  return ticks;
}

export function valueTicks([low, high]: [number, number], count = 4) {
  const span = high - low;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const out: number[] = [];
  for (let value = Math.ceil(low / step) * step; value <= high + 1e-9; value += step) out.push(Number(value.toFixed(6)));
  return out;
}

function path(points: { x: number; y: number }[]) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join("");
}

export function TimeSeriesChart({
  lines,
  bands = [],
  targets = [],
  ticks = [],
  shades = [],
  domain,
  yDomain,
  height = 220,
  ariaLabel,
  description,
  readout,
  stepMs,
  compact = false,
  emptyText,
}: {
  lines: ChartLine[];
  bands?: ChartBand[];
  targets?: ChartTarget[];
  /** Controller events drawn as short ticks along the bottom (e.g. valve openings). */
  ticks?: ChartTick[];
  /** Shaded stretches with a label (e.g. "no readings"). */
  shades?: ChartShade[];
  domain: { startMs: number; endMs: number };
  yDomain: [number, number];
  height?: number;
  ariaLabel: string;
  description?: ReactNode;
  readout?: (timestampMs: number) => ChartReadout | null;
  /** Keyboard step; defaults to 1/96 of the window. */
  stepMs?: number;
  compact?: boolean;
  emptyText?: string;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [cursor, setCursor] = useState<number | null>(null);
  const descId = useId();
  const margin = compact ? { left: 34, right: 8, top: 6, bottom: 20 } : chartMargin;
  const plotWidth = Math.max(10, width - margin.left - margin.right);
  const plotHeight = Math.max(10, height - margin.top - margin.bottom);
  const span = Math.max(1, domain.endMs - domain.startMs);
  const x = (t: number) => margin.left + ((t - domain.startMs) / span) * plotWidth;
  const y = (v: number) => margin.top + (1 - (v - yDomain[0]) / Math.max(1e-9, yDomain[1] - yDomain[0])) * plotHeight;
  const xTicks = useMemo(() => (width ? timeTicks(domain, plotWidth) : []), [domain, plotWidth, width]);
  const yTicks = useMemo(() => valueTicks(yDomain, compact ? 3 : 4), [compact, yDomain]);
  const hasData = lines.some((line) => line.segments.some((segment) => segment.length)) || bands.some((band) => band.segments.some((segment) => segment.length));
  const step = stepMs ?? span / 96;
  const info = cursor != null && readout ? readout(cursor) : null;

  const moveTo = (clientX: number) => {
    const element = ref.current;
    if (!element) return;
    const left = element.getBoundingClientRect().left;
    const t = domain.startMs + ((clientX - left - margin.left) / plotWidth) * span;
    setCursor(Math.min(domain.endMs, Math.max(domain.startMs, t)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const base = cursor ?? domain.endMs;
    const multiplier = event.shiftKey ? 8 : 1;
    if (event.key === "ArrowLeft") setCursor(Math.max(domain.startMs, base - step * multiplier));
    else if (event.key === "ArrowRight") setCursor(Math.min(domain.endMs, base + step * multiplier));
    else if (event.key === "Home") setCursor(domain.startMs);
    else if (event.key === "End") setCursor(domain.endMs);
    else if (event.key === "Escape") setCursor(null);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={ref}
      className="px-chart"
      role="img"
      aria-label={ariaLabel}
      aria-describedby={description ? descId : undefined}
      tabIndex={readout ? 0 : undefined}
      onKeyDown={readout ? onKeyDown : undefined}
      onPointerMove={readout ? (event: PointerEvent<HTMLDivElement>) => moveTo(event.clientX) : undefined}
      onPointerLeave={readout ? () => setCursor(null) : undefined}
      onBlur={() => setCursor(null)}
    >
      {description ? <p id={descId} className="px-sr-only">{description}</p> : null}
      {width > 0 ? (
        <svg width={width} height={height} aria-hidden="true">
          {yTicks.map((value) => (
            <g key={`y${value}`}>
              <line x1={margin.left} x2={margin.left + plotWidth} y1={y(value)} y2={y(value)} className="px-chart-grid" />
              <text x={margin.left - 6} y={y(value) + 3} textAnchor="end" className="px-chart-axis">{value}</text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <g key={`x${tick.at}`}>
              <line x1={x(tick.at)} x2={x(tick.at)} y1={margin.top} y2={margin.top + plotHeight} className="px-chart-grid" />
              <text x={x(tick.at)} y={height - 7} textAnchor="middle" className="px-chart-axis">{tick.label}</text>
            </g>
          ))}
          {shades.map((shade, index) => {
            const x0 = Math.max(margin.left, x(shade.startMs));
            const x1 = Math.min(margin.left + plotWidth, x(shade.endMs));
            if (x1 - x0 < 1) return null;
            const room = x1 - x0 > shade.label.length * 6 + 8;
            return (
              <g key={`s${index}`}>
                <rect x={x0} y={margin.top} width={x1 - x0} height={plotHeight} fill="rgba(138, 63, 10, 0.07)" />
                <line x1={x0} x2={x0} y1={margin.top} y2={margin.top + plotHeight} stroke="rgba(138, 63, 10, 0.35)" strokeDasharray="3 3" />
                {room && !compact ? <text x={x0 + 4} y={margin.top + 11} className="px-chart-gaplabel">{shade.label}</text> : null}
              </g>
            );
          })}
          {bands.map((band) => band.segments.map((segment, index) => {
            if (!segment.length) return null;
            const top = segment.map((point) => ({ x: x(point.timestampMs), y: y(point.high) }));
            const bottom = segment.slice().reverse().map((point) => ({ x: x(point.timestampMs), y: y(point.low) }));
            if (segment.length === 1) {
              return <line key={`${band.id}-${index}`} x1={top[0].x} x2={top[0].x} y1={top[0].y} y2={bottom[0].y} stroke={band.color} strokeOpacity={0.4} strokeWidth={3} />;
            }
            return <path key={`${band.id}-${index}`} d={`${path(top)}L${path(bottom).slice(1)}Z`} fill={band.color} fillOpacity={band.opacity ?? 0.16} />;
          }))}
          {lines.map((line) => line.segments.map((segment, index) => {
            if (!segment.length) return null;
            if (segment.length === 1) {
              return <circle key={`${line.id}-${index}`} cx={x(segment[0].timestampMs)} cy={y(segment[0].value)} r={2.2} fill={line.color} opacity={line.opacity ?? 1} />;
            }
            return (
              <path
                key={`${line.id}-${index}`}
                d={path(segment.map((point) => ({ x: x(point.timestampMs), y: y(point.value) })))}
                fill="none"
                stroke={line.color}
                strokeWidth={line.width ?? 1.8}
                strokeOpacity={line.opacity ?? 1}
                strokeDasharray={line.dash ?? undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          }))}
          {targets.map((target) => (
            <line key={`t${target.label}`} x1={margin.left} x2={margin.left + plotWidth} y1={y(target.value)} y2={y(target.value)} stroke={target.color} strokeWidth={1} strokeDasharray={target.dash ?? "1 0"} />
          ))}
          {!compact ? targets.map((target, index) => (
            <text key={`tl${target.label}`} x={margin.left + plotWidth - 4} y={y(target.value) - 4 - (index % 2) * 0} textAnchor="end" className="px-chart-target" fill={target.color}>
              {target.label}
            </text>
          )) : null}
          {ticks.map((tick, index) => {
            const tx = x(tick.timestampMs);
            if (tx < margin.left || tx > margin.left + plotWidth) return null;
            return <line key={`k${index}`} x1={tx} x2={tx} y1={margin.top + plotHeight - 6} y2={margin.top + plotHeight} stroke="#1f5f8b" strokeOpacity={0.55} />;
          })}
          {cursor != null ? (
            <line x1={x(cursor)} x2={x(cursor)} y1={margin.top} y2={margin.top + plotHeight} className="px-chart-cursor" />
          ) : null}
          {!hasData ? (
            <text x={margin.left + plotWidth / 2} y={margin.top + plotHeight / 2} textAnchor="middle" className="px-chart-axis">
              {emptyText ?? "No readings in this window"}
            </text>
          ) : null}
        </svg>
      ) : <div style={{ height }} />}
      {info && cursor != null ? (
        <div
          className="px-chart-readout"
          role="status"
          style={{ left: Math.min(Math.max(0, x(cursor) + 10), Math.max(0, width - 200)), top: margin.top + 4 }}
        >
          <b>{info.title}</b>
          {info.rows.map((row) => (
            <div key={row.label}><span>{row.label}</span>{row.value}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

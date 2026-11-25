import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { type HealthChartPoint } from "../portalTypes";
import { healthChartWindow } from "./healthHistory";

const HEIGHT = 190, LEFT = 52, RIGHT = 12, TOP = 14, BOTTOM = 26;

/** Round axis steps: 1, 2 or 5 times a power of ten. */
function axis(low: number, high: number, floor?: number, fromFloor = false) {
  if (fromFloor && floor != null) low = floor;
  if (high - low < 1e-9) { low -= 1; high += 1; }
  const rough = (high - low) / 3, power = 10 ** Math.floor(Math.log10(rough)), ratio = rough / power;
  const step = (ratio > 5 ? 10 : ratio > 2 ? 5 : ratio > 1 ? 2 : 1) * power;
  let min = Math.floor(low / step) * step;
  // A count is measured from its floor; anything else is only kept above it.
  if (floor != null) min = fromFloor ? floor : Math.max(floor, min);
  const max = Math.max(min + step, Math.ceil(high / step) * step);
  const ticks: number[] = [];
  for (let value = min; value <= max + step / 1000; value += step) ticks.push(Number(value.toFixed(6)));
  return { min, max, ticks };
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

/** One quantity over time: a line on a quiet grid, with the reading under the pointer. */
export function HealthLineChart({
  label, points, unit = "", digits = 0, floor, count = false, states, marks = [], tone = "ok",
}: {
  label: string;
  points: HealthChartPoint[];
  unit?: string;
  digits?: number;
  /** The axis never goes below this. */
  floor?: number;
  /** A count: the axis starts at the floor. */
  count?: boolean;
  /** Names for 0 and 1 when the series is a yes/no state. It is then drawn in steps. */
  states?: [string, string];
  /** Moments worth pointing at, such as a restart. */
  marks?: { t: number; label: string }[];
  tone?: "ok" | "warning";
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [offset, setOffset] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const known = useMemo(() => points.filter((point) => point.value != null && Number.isFinite(point.value)), [points]);
  const span = useMemo(() => healthChartWindow(known.map((point) => point.t), offset), [known, offset]);
  const shown = useMemo(() => known.filter((point) => point.t >= span.startMs && point.t <= span.endMs), [known, span.startMs, span.endMs]);
  useEffect(() => { if (offset > span.maxOffset) setOffset(span.maxOffset); }, [offset, span.maxOffset]);

  const values = shown.map((point) => point.value as number);
  const scale = states ? { min: -0.25, max: 1.25, ticks: [0, 1] }
    : values.length ? axis(Math.min(...values), Math.max(...values), floor, count) : { min: 0, max: 1, ticks: [] };
  const plotW = width - LEFT - RIGHT, plotH = HEIGHT - TOP - BOTTOM;
  const x = (time: number) => LEFT + ((time - span.startMs) / Math.max(1, span.endMs - span.startMs)) * plotW;
  const y = (value: number) => TOP + plotH - ((value - scale.min) / Math.max(1e-9, scale.max - scale.min)) * plotH;
  // A stretch with no samples is left open instead of being drawn across.
  const steps = shown.slice(1).map((point, index) => point.t - shown[index].t).sort((a, b) => a - b);
  const usual = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
  const runs: HealthChartPoint[][] = [];
  shown.forEach((point, index) => {
    // Stored history trails the newest readings by a few minutes, so only a silence of a quarter hour or more counts.
    if (!index || point.t - shown[index - 1].t > Math.max(usual * 6, 900_000)) runs.push([]);
    runs[runs.length - 1].push(point);
  });
  const path = (run: HealthChartPoint[]) => run.map((point, index) => `${index ? (states ? `H${x(point.t).toFixed(1)} V` : "L") : "M"}${states && index ? "" : `${x(point.t).toFixed(1)} `}${y(point.value as number).toFixed(1)}`).join(" ");
  // A single sample has one time; a narrow chart has room for the two ends only.
  const parts = span.endMs - span.startMs < 120_000 ? [0] : width < 420 ? [0, 3] : [0, 1, 2, 3];
  const sameDay = day(span.startMs) === day(span.endMs);
  const picked = hover == null ? null : shown[hover] ?? null;
  const text = (value: number) => states ? states[value >= 0.5 ? 1 : 0] : `${Number(value.toFixed(digits))}${unit}`;

  function move(event: PointerEvent<SVGSVGElement>) {
    if (!shown.length) return;
    const frame = event.currentTarget.getBoundingClientRect();
    const at = span.startMs + (((event.clientX - frame.left) / frame.width) * width - LEFT) / plotW * (span.endMs - span.startMs);
    let best = 0;
    shown.forEach((point, index) => { if (Math.abs(point.t - at) < Math.abs(shown[best].t - at)) best = index; });
    setHover(best);
  }

  return (
    <div ref={box} className={`sh-chart is-${tone}`}>
      <div className="sh-chart-bar">
        <span className="sh-chart-readout" aria-live="off">
          {picked ? <><strong>{text(picked.value as number)}</strong> {sameDay ? "" : `${day(picked.t)}, `}{clock(picked.t)}</> : shown.length ? `${sameDay ? day(span.startMs) : `${day(span.startMs)} – ${day(span.endMs)}`}` : ""}
        </span>
        {span.maxOffset > 0 ? <span className="sh-chart-steps">
          <button type="button" aria-label={`Earlier ${label}`} disabled={offset >= span.maxOffset} onClick={() => { setHover(null); setOffset(Math.min(span.maxOffset, offset + 1)); }}>‹</button>
          <button type="button" aria-label={`Later ${label}`} disabled={offset <= 0} onClick={() => { setHover(null); setOffset(Math.max(0, offset - 1)); }}>›</button>
        </span> : null}
      </div>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={`${label} over time`} onPointerMove={move} onPointerLeave={() => setHover(null)}>
        {scale.ticks.map((tick) => <g key={tick}>
          <line className="sh-chart-grid" x1={LEFT} x2={width - RIGHT} y1={y(tick)} y2={y(tick)} />
          <text className="sh-chart-label" x={LEFT - 8} y={y(tick) + 3.5} textAnchor="end">{text(tick)}</text>
        </g>)}
        {parts.map((part) => <text key={part} className="sh-chart-label sh-chart-time" x={x(span.startMs + ((span.endMs - span.startMs) * part) / 3)} y={HEIGHT - 7}
          textAnchor={part === 0 ? "start" : part === 3 ? "end" : "middle"}>{clock(span.startMs + ((span.endMs - span.startMs) * part) / 3)}</text>)}
        {runs.map((run, index) => run.length > 1
          ? <g key={index}>
              <path className="sh-chart-area" d={`${path(run)} L${x(run[run.length - 1].t).toFixed(1)} ${TOP + plotH} L${x(run[0].t).toFixed(1)} ${TOP + plotH} Z`} />
              <path className="sh-chart-line" d={path(run)} />
            </g>
          : <circle key={index} className="sh-chart-point" cx={x(run[0].t)} cy={y(run[0].value as number)} r="2.5" />)}
        {marks.filter((mark) => mark.t >= span.startMs && mark.t <= span.endMs).map((mark) => <g key={mark.t}>
          <line className="sh-chart-mark" x1={x(mark.t)} x2={x(mark.t)} y1={TOP} y2={TOP + plotH} />
          <text className="sh-chart-label sh-chart-mark-label" x={x(mark.t) + (x(mark.t) > width - 70 ? -5 : 5)} y={TOP + 9} textAnchor={x(mark.t) > width - 70 ? "end" : "start"}>{mark.label} {clock(mark.t)}</text>
        </g>)}
        {picked ? <g>
          <line className="sh-chart-guide" x1={x(picked.t)} x2={x(picked.t)} y1={TOP} y2={TOP + plotH} />
          <circle className="sh-chart-point" cx={x(picked.t)} cy={y(picked.value as number)} r="3.5" />
        </g> : null}
        {!shown.length ? <text className="sh-chart-empty" x={width / 2} y={HEIGHT / 2} textAnchor="middle">No history yet</text> : null}
      </svg>
    </div>
  );
}

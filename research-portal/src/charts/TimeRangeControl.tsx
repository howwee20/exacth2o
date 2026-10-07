import { type CSSProperties, type PointerEvent, useCallback, useRef } from "react";
import { fullTimeWindow, minTimeWindowSpan } from "../portalConstants";
import { formatDateTime } from "../portalFormat";
import { type TimeBounds, type TimeWindow } from "../portalTypes";
import { timeFromPercent } from "./chartGeometry";

export function TimeRangeControl({
  bounds,
  value,
  onChange,
}: {
  bounds: TimeBounds | null;
  value: TimeWindow;
  onChange: (value: TimeWindow) => void;
}) {
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const start = Math.max(0, Math.min(value.start, value.end - minTimeWindowSpan));
  const end = Math.min(100, Math.max(value.end, value.start + minTimeWindowSpan));
  const isFull = start <= 0.1 && end >= 99.9;

  const percentFromClientX = useCallback((clientX: number) => {
    const slider = sliderRef.current;
    if (!slider) return null;
    const rect = slider.getBoundingClientRect();
    const inset = 12;
    const left = rect.left + inset;
    const width = Math.max(1, rect.width - inset * 2);
    return Math.max(0, Math.min(100, ((clientX - left) / width) * 100));
  }, []);

  const setEdgeFromClientX = useCallback(
    (edge: "start" | "end", clientX: number) => {
      const next = percentFromClientX(clientX);
      if (next == null) return;
      if (edge === "start") {
        onChange({
          start: Math.min(next, end - minTimeWindowSpan),
          end,
        });
        return;
      }
      onChange({
        start,
        end: Math.max(next, start + minTimeWindowSpan),
      });
    },
    [end, onChange, percentFromClientX, start],
  );

  const startDrag = useCallback(
    (edge: "start" | "end", event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      setEdgeFromClientX(edge, event.clientX);

      const move = (moveEvent: globalThis.PointerEvent) => {
        setEdgeFromClientX(edge, moveEvent.clientX);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [setEdgeFromClientX],
  );

  const startNearestDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const next = percentFromClientX(event.clientX);
      if (next == null) return;
      const edge = Math.abs(next - start) <= Math.abs(next - end) ? "start" : "end";
      startDrag(edge, event);
    },
    [end, percentFromClientX, start, startDrag],
  );

  if (!bounds) return null;
  const startMs = timeFromPercent(bounds, start);
  const endMs = timeFromPercent(bounds, end);

  return (
    <div
      className="time-range-control"
      style={{
        "--range-start": `${start}%`,
        "--range-end": `${100 - end}%`,
      } as CSSProperties}
    >
      <div className="time-range-labels">
        <span>{formatDateTime(startMs)}</span>
        <button type="button" onClick={() => onChange(fullTimeWindow)} disabled={isFull}>
          Full
        </button>
        <span>{formatDateTime(endMs)}</span>
      </div>
      <div className="time-range-slider" ref={sliderRef} onPointerDown={startNearestDrag}>
        <div className="time-range-track">
          <span />
        </div>
        <div className="time-range-handles">
          <button
            type="button"
            className="time-range-handle is-start"
            aria-label="Start time"
            onPointerDown={(event) => {
              event.stopPropagation();
              startDrag("start", event);
            }}
          />
          <button
            type="button"
            className="time-range-handle is-end"
            aria-label="End time"
            onPointerDown={(event) => {
              event.stopPropagation();
              startDrag("end", event);
            }}
          />
        </div>
      </div>
    </div>
  );
}

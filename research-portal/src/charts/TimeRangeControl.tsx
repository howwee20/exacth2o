import { type CSSProperties, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { fullTimeWindow, minTimeWindowSpan } from "../portalConstants";
import { formatDateTime } from "../portalFormat";
import { type TimeBounds, type TimeWindow } from "../portalTypes";
import { timeFromPercent } from "./chartGeometry";
import { customTimeWindow, presetTimeWindow, timeRangePresets } from "./timeRangePresets";

const localInput = (at: number) => {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
};

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
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [customError, setCustomError] = useState("");
  const pinnedPreset = useRef<{ hours: number | null; value: TimeWindow } | null>({ hours: null, value: fullTimeWindow });
  useEffect(() => {
    const pinned = pinnedPreset.current;
    if (!bounds || !pinned) return;
    if (value.start !== pinned.value.start || value.end !== pinned.value.end) { pinnedPreset.current = null; return; }
    const next = presetTimeWindow(bounds, pinned.hours);
    pinned.value = next;
    if (next.start !== value.start || next.end !== value.end) onChange(next);
  }, [bounds, onChange, value]);
  // A percentage floor must not turn a 24-hour view into weeks on long experiments.
  const minimumSpan = bounds ? Math.min(minTimeWindowSpan, 100 * 60_000 / Math.max(1, bounds.endMs - bounds.startMs)) : minTimeWindowSpan;
  const start = Math.max(0, Math.min(value.start, value.end - minimumSpan));
  const end = Math.min(100, Math.max(value.end, value.start + minimumSpan));

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
      pinnedPreset.current = null;
      if (edge === "start") {
        onChange({
          start: Math.min(next, end - minimumSpan),
          end,
        });
        return;
      }
      onChange({
        start,
        end: Math.max(next, start + minimumSpan),
      });
    },
    [end, minimumSpan, onChange, percentFromClientX, start],
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
  const selected = timeRangePresets.find((preset) => {
    const next = presetTimeWindow(bounds, preset.hours);
    return Math.abs(next.start - start) < 0.0001 && Math.abs(next.end - end) < 0.0001;
  });
  const stepEdge = (edge: "start" | "end", key: string) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
    const delta = steps[key];
    if (delta !== undefined || key === "Home" || key === "End") pinnedPreset.current = null;
    if (key === "Home") onChange(edge === "start" ? { start: 0, end } : { start, end: start + minimumSpan });
    else if (key === "End") onChange(edge === "end" ? { start, end: 100 } : { start: end - minimumSpan, end });
    else if (delta !== undefined) onChange(edge === "start"
      ? { start: Math.max(0, Math.min(start + delta, end - minimumSpan)), end }
      : { start, end: Math.min(100, Math.max(end + delta, start + minimumSpan)) });
    else return false;
    return true;
  };

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
            role="slider"
            aria-label="Start time"
            aria-valuemin={0} aria-valuemax={end - minimumSpan} aria-valuenow={start} aria-valuetext={formatDateTime(startMs)}
            onKeyDown={(event) => { if (stepEdge("start", event.key)) event.preventDefault(); }}
            onPointerDown={(event) => {
              event.stopPropagation();
              startDrag("start", event);
            }}
          />
          <button
            type="button"
            className="time-range-handle is-end"
            role="slider"
            aria-label="End time"
            aria-valuemin={start + minimumSpan} aria-valuemax={100} aria-valuenow={end} aria-valuetext={formatDateTime(endMs)}
            onKeyDown={(event) => { if (stepEdge("end", event.key)) event.preventDefault(); }}
            onPointerDown={(event) => {
              event.stopPropagation();
              startDrag("end", event);
            }}
          />
        </div>
      </div>
      <div className="time-range-presets" role="group" aria-label="Time range">
        {timeRangePresets.map((preset) => <button key={preset.label} type="button" aria-pressed={!customOpen && selected === preset}
          onClick={() => { setCustomOpen(false); setCustomError(""); const next = presetTimeWindow(bounds, preset.hours); pinnedPreset.current = { hours: preset.hours, value: next }; onChange(next); }}>{preset.label}</button>)}
        <button type="button" aria-pressed={customOpen || !selected} onClick={() => {
          setCustomStart(localInput(startMs)); setCustomEnd(localInput(endMs)); setCustomError(""); setCustomOpen((open) => !open);
        }}>Custom</button>
      </div>
      {customOpen ? <form className="time-range-custom" onSubmit={(event) => {
        event.preventDefault();
        const next = customTimeWindow(bounds, Date.parse(customStart), Date.parse(customEnd));
        if (!next) { setCustomError("Choose a start and end within the experiment dates."); return; }
        setCustomError(""); setCustomOpen(false); pinnedPreset.current = null; onChange(next);
      }}>
        <label>Start (local time)<input type="datetime-local" step="1" required value={customStart} min={localInput(bounds.startMs)} max={localInput(bounds.endMs)} onChange={(event) => setCustomStart(event.target.value)} /></label>
        <label>End (local time)<input type="datetime-local" step="1" required value={customEnd} min={localInput(bounds.startMs)} max={localInput(bounds.endMs)} onChange={(event) => setCustomEnd(event.target.value)} /></label>
        <button type="submit">Apply</button>
        {customError ? <p role="alert">{customError}</p> : null}
      </form> : null}
    </div>
  );
}

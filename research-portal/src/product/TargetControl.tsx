import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { dragTarget } from './directExperimentModel';

/** Chart geometry the target layer needs, frozen by the chart while a drag is in progress. */
export type TargetGeometry = { yScale: (value: number) => number; top: number; bottom: number; left: number; right: number; pixelsPerPercent: number; low: number; high: number };

type Drag = { pointerId: number; startY: number; startValue: number; scale: number; low: number; high: number; moved: boolean };

/**
 * Pointer handling shared by a pill and its line. Each move is computed from the gesture's
 * start and the scale captured at pointer-down, so the control never accelerates or jumps.
 */
export function useTargetDrag({ value, pixelsPerPercent, low, high, disabled, onStart, onPreview, onEnd, onTap }: {
  value: number; pixelsPerPercent: number; low: number; high: number; disabled: boolean;
  onStart: () => void; onPreview: (value: number) => void; onEnd: () => void; onTap?: () => void;
}) {
  const drag = useRef<Drag | null>(null);
  const last = useRef(value);
  const finish = (element: Element, pointerId: number, tap: boolean) => {
    if (drag.current?.pointerId !== pointerId) return;
    drag.current = null;
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    onEnd();
    if (tap) onTap?.();
  };
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (disabled || event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* moves still arrive while over the control */ }
      drag.current = { pointerId: event.pointerId, startY: event.clientY, startValue: value, scale: pixelsPerPercent, low, high, moved: false };
      last.current = value;
      onStart();
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (Math.abs(event.clientY - current.startY) > 3) current.moved = true;
      const next = dragTarget(current.startValue, current.startY, event.clientY, current.scale, current.low, current.high);
      if (next !== last.current) { last.current = next; onPreview(next); }
    },
    onPointerUp(event: PointerEvent<HTMLElement>) { finish(event.currentTarget, event.pointerId, !drag.current?.moved); },
    onPointerCancel(event: PointerEvent<HTMLElement>) { finish(event.currentTarget, event.pointerId, false); },
    onLostPointerCapture(event: PointerEvent<HTMLElement>) { if (drag.current?.pointerId === event.pointerId) { drag.current = null; onEnd(); } },
  };
}

export function TargetPill({ label, value, previewing, ariaLabel, disabled, dimmed, pixelsPerPercent, low, high, onStart, onPreview, onEnd, onTap, onStep, onCancel, onOpen, pillRef }: {
  label: string; value: number; previewing: boolean; ariaLabel: string; disabled: boolean; dimmed: boolean; pixelsPerPercent: number; low: number; high: number;
  onStart: () => void; onPreview: (value: number) => void; onEnd: () => void; onTap: () => void; onStep: (delta: number) => void; onCancel: () => void; onOpen: () => void;
  pillRef?: (element: HTMLButtonElement | null) => void;
}) {
  const handlers = useTargetDrag({ value, pixelsPerPercent, low, high, disabled, onStart, onPreview, onEnd, onTap });
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const steps: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 };
    if (event.key in steps) { event.preventDefault(); if (!disabled) onStep(steps[event.key]); }
    else if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    else if ((event.key === 'Enter' || event.key === ' ') && !disabled) { event.preventDefault(); onOpen(); }
  };
  return (
    <button
      ref={pillRef}
      type="button"
      role="slider"
      className={`px-tpill${previewing ? ' is-preview' : ''}${dimmed ? ' is-dimmed' : ''}`}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={80}
      aria-valuenow={value}
      aria-valuetext={`${value}% target${previewing ? ', not applied' : ''}`}
      aria-orientation="vertical"
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      {...handlers}
    >
      {label}
    </button>
  );
}

/** Invisible grab area along a target line, so the line itself can be dragged. */
export function TargetBand({ value, top, left, right, pixelsPerPercent, low, high, disabled, onStart, onPreview, onEnd }: {
  value: number; top: number; left: number; right: number; pixelsPerPercent: number; low: number; high: number; disabled: boolean;
  onStart: () => void; onPreview: (value: number) => void; onEnd: () => void;
}) {
  const handlers = useTargetDrag({ value, pixelsPerPercent, low, high, disabled, onStart, onPreview, onEnd });
  if (disabled) return null;
  return <div className="px-tband" style={{ top, left, width: Math.max(0, right - left) }} aria-hidden="true" {...handlers} />;
}

/** A small popover anchored under the pill; closes on Escape or a click outside it. */
export function TargetPopover({ up, onClose, children }: { up: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const away = (event: globalThis.PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current && target && !ref.current.contains(target) && !target.closest('.px-tpill')) onClose();
    };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return <div ref={ref} className={`px-tpopover${up ? ' is-up' : ''}`} role="dialog" aria-label="Target options">{children}</div>;
}

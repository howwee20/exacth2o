import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { controllerOwnership, useControllerOwnership } from './controllerOwnership';
import { HoldInputMachine, type HoldInputEvent, type HoldInterruptReason } from './holdInput';
import { HoldSession, type HoldView } from './holdSession';
import type { Destination, ManualWaterClient } from './manualWaterApi';

type Availability = { state: 'checking' | 'ready' | 'busy' | 'unavailable'; message: string; busyLabel?: string | null; maxContinuousMs?: number | null };

const phaseWords: Record<string, string> = {
  checking: 'Checking', ready: 'Ready', busy: 'In use', unavailable: 'Unavailable',
  taking_control: 'Taking control', opening: 'Opening', open: 'Controller: open', stopping: 'Stopping',
  closed: 'Controller: closed', ended: 'Ended', refused: 'Not started', unconfirmed: 'Unconfirmed', fault: 'Fault',
};
const toneFor = (phase: string) => ({ ready: 'ready', open: 'active', opening: 'active', taking_control: 'active', stopping: 'pending', checking: 'pending', busy: 'pending', closed: 'idle' } as Record<string, string>)[phase]
  ?? (['refused', 'unconfirmed', 'unavailable', 'fault'].includes(phase) ? 'alert' : 'idle');

function formatElapsed(ms: number) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(Math.floor(seconds % 60)).padStart(2, '0')} s`;
}

function destinationKey(destination: Destination) {
  return destination.kind === 'pot' ? `pot:${destination.potNumber}` : `out:${destination.relayAddress}:${destination.channel}`;
}

/**
 * Press and hold to water one destination: a physical pot by its recorded route, or a
 * configured solenoid directly. The controller owns the valve: each hold is a session
 * kept open by a short renewable lease, closed on release, and closed by the
 * controller itself if renewals stop. The destination is fixed for a session; a
 * different destination is a different session.
 */
export function HoldWaterControl({ client, destination, label, identity, renewMs, leaseMs, canTakeover = true }: {
  client: ManualWaterClient;
  destination: Destination;
  /** Short name of the destination for messages ("Solenoid 74", "Pot 16"). */
  label: string;
  /** Identity lines shown with the control: board/channel, physical pot, pairing. */
  identity?: ReactNode;
  renewMs?: number;
  leaseMs?: number;
  canTakeover?: boolean;
}) {
  const [availability, setAvailability] = useState<Availability>({ state: 'checking', message: 'Checking the controller…' });
  const [view, setView] = useState<HoldView | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const [takeover, setTakeover] = useState(false);
  const [autocalConfirmed, setAutocalConfirmed] = useState(false);
  const session = useRef<HoldSession | null>(null);
  const releaseOwnership = useRef<(() => void) | null>(null);
  const input = useRef(new HoldInputMachine());
  const statusId = useId();
  const [checkVersion, setCheckVersion] = useState(0);
  const ownership = useControllerOwnership();
  const autocalRunning = Boolean(ownership.autocal);
  const key = destinationKey(destination);

  const endSession = useCallback((reason?: string) => {
    session.current?.release(reason);
  }, []);

  const interrupt = useCallback((reason: HoldInterruptReason) => {
    const action = input.current.handle({ type: 'interrupt', reason });
    if (action?.action === 'release') {
      const words: Partial<Record<HoldInterruptReason, string>> = { blur: 'The window lost focus', hidden: 'The page was hidden', pagehide: 'The page closed', offline: 'The connection dropped', destination: 'The destination changed', disabled: 'The control was disabled', unmount: 'The control closed', escape: 'Escape pressed', signout: 'Signed out' };
      endSession(words[reason] ?? 'Interrupted');
    }
  }, [endSession]);

  // Availability: is hold-to-water commissioned, healthy and free on this controller?
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let failures = 0;
    const check = async () => {
      if (disposed || pending || document.hidden) return;
      pending = true;
      const result = await client.hold('status', destination, crypto.randomUUID(), 0, { timeoutMs: 10000 });
      pending = false;
      if (disposed || !result) return;
      if (!result.ok) {
        if (result.transient) {
          failures += 1;
          setAvailability({ state: 'checking', message: 'Reconnecting to the controller… Retrying automatically.' });
          timer = setTimeout(() => void check(), Math.min(1000 * failures, 5000));
        } else setAvailability({ state: 'unavailable', message: result.error });
        return;
      }
      failures = 0;
      const reply = result.data;
      if (reply.available === false) setAvailability({ state: 'unavailable', message: 'Hold-to-water is not commissioned on this controller.' });
      else if (reply.ready === false) setAvailability({ state: 'unavailable', message: reply.fault ? `Manual watering is paused: ${reply.fault}. An operator must check the outlets and reconcile.` : 'The controller is recovering from a valve fault. Manual watering is paused until it is reconciled.' });
      else if (reply.configRewrite) {
        setAvailability({ state: 'busy', message: 'A pairing change is being applied on the controller. Manual watering resumes when it finishes.' });
        timer = setTimeout(() => void check(), 2000);
      } else if (reply.busy) {
        setAvailability({ state: 'busy', message: reply.activeOwnerLabel ? `In use by ${reply.activeOwnerLabel}.` : 'Another hold is running on this controller.', busyLabel: reply.activeOwnerLabel ?? null });
        timer = setTimeout(() => void check(), 2000);
      } else setAvailability({ state: 'ready', message: 'Ready', maxContinuousMs: reply.maxContinuousMilliseconds ?? null });
    };
    void check();
    const resume = () => { clearTimeout(timer); void check(); };
    const onVisibility = () => { if (document.hidden) interrupt('hidden'); else resume(); };
    const onBlur = () => interrupt('blur');
    const onPageHide = () => interrupt('pagehide');
    const onOffline = () => interrupt('offline');
    window.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      interrupt('unmount');
      endSession('The control closed');
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // A new destination is a new control: the previous session is released first.
  }, [client, key, checkVersion, interrupt, endSession]); // eslint-disable-line react-hooks/exhaustive-deps

  const holding = view != null && ['taking_control', 'opening', 'open'].includes(view.phase);
  useEffect(() => {
    if (!holding) return undefined;
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, [holding]);

  // Release this tab's claim on the controller once the session is over.
  useEffect(() => {
    if (view && !['taking_control', 'opening', 'open', 'stopping'].includes(view.phase)) {
      releaseOwnership.current?.();
      releaseOwnership.current = null;
    }
  }, [view]);

  const needsAutocalConfirm = autocalRunning && !autocalConfirmed;
  const canPress = (availability.state === 'ready' || (availability.state === 'busy' && takeover && canTakeover)) && !holding && view?.phase !== 'stopping' && !needsAutocalConfirm;

  const press = () => {
    if (!canPress) return false;
    // Manual troubleshooting takes priority over an autocalibration run in this tab:
    // stop it first, so no queued pulse starts and its evidence is marked interrupted.
    controllerOwnership.interruptAutocalForManual(label);
    const sessionId = crypto.randomUUID();
    const next = new HoldSession(
      (action, sequence, options) => client.hold(action, destination, sessionId, sequence, options),
      (state) => { if (session.current === next) setView(state); },
      { renewMs: renewMs ?? 500, leaseMs: leaseMs ?? 2500 },
    );
    session.current = next;
    releaseOwnership.current = controllerOwnership.claimHold({ kind: 'manual_hold', sessionId, label, stop: () => next.release('Stopped') });
    setNow(performance.now());
    next.begin(availability.state === 'busy' && takeover ? 'takeover' : 'start');
    return true;
  };

  const onInput = (event: HoldInputEvent) => {
    if (event.type === 'pointerdown' || event.type === 'keydown') {
      if (!canPress && input.current.state.kind === 'idle' && !(event.type === 'keydown' && event.key === 'Escape')) return;
    }
    const action = input.current.handle(event);
    if (action?.action === 'press') {
      if (!press()) input.current.handle({ type: 'interrupt', reason: 'disabled' });
    } else if (action?.action === 'release') {
      endSession(action.reason === 'escape' ? 'Escape pressed' : 'Released');
    }
  };

  const phase = view?.phase ?? availability.state;
  const message = view ? view.message : availability.message;
  const recheck = !holding && (availability.state === 'unavailable' || availability.state === 'busy' || ['unconfirmed', 'fault', 'refused', 'busy'].includes(view?.phase ?? ''));
  const maxContinuous = view?.maxContinuousMs ?? availability.maxContinuousMs ?? null;
  const elapsedMs = view?.openedAt != null && (holding || view.phase === 'stopping') ? now - view.openedAt : null;
  const buttonLabel = view?.phase === 'open' ? 'Watering' : view?.phase === 'opening' ? 'Opening…' : view?.phase === 'taking_control' ? 'Taking control…' : availability.state === 'busy' && takeover ? 'Hold to take over' : 'Hold to water';
  const describedBy = useMemo(() => `${statusId}`, [statusId]);

  return (
    <section className="px-water" aria-label={`Manual water, ${label}`} data-phase={phase}>
      <div className="px-water-head">
        <h3>Manual water · {label}</h3>
        <span className="px-water-state" data-tone={toneFor(phase)}>{phaseWords[phase] ?? phase}</span>
      </div>
      {identity ? <div className="px-water-identity">{identity}</div> : null}
      {needsAutocalConfirm ? (
        <div className="px-water-confirm" role="alert">
          <p>Autocalibration is running in this tab. Manual watering stops it; its evidence is kept and it must be resumed after the pots settle.</p>
          <button type="button" className="px-button is-small" onClick={() => setAutocalConfirmed(true)}>Stop autocalibration when I hold</button>
        </div>
      ) : null}
      {availability.state === 'busy' && canTakeover && !holding ? (
        <label className="px-water-takeover">
          <input type="checkbox" checked={takeover} onChange={(event) => setTakeover(event.target.checked)} />
          <span>Take over: close the other hold first, then water {label}</span>
        </label>
      ) : null}
      <button
        type="button"
        className={`px-hold${holding ? ' is-holding' : ''}${view?.phase === 'open' ? ' is-watering' : ''}`}
        disabled={!canPress && !holding}
        aria-describedby={describedBy}
        aria-pressed={holding}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          event.preventDefault();
          const wasIdle = !input.current.holding;
          onInput({ type: 'pointerdown', pointerId: event.pointerId, pointerType: event.pointerType, button: event.button, isPrimary: event.isPrimary });
          if (wasIdle && input.current.state.kind === 'pointer') {
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
          }
        }}
        onPointerUp={(event) => onInput({ type: 'pointerup', pointerId: event.pointerId })}
        onPointerCancel={(event) => onInput({ type: 'pointercancel', pointerId: event.pointerId })}
        onLostPointerCapture={(event) => onInput({ type: 'lostpointercapture', pointerId: event.pointerId })}
        onBlur={() => interrupt('blur')}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter' || event.key === 'Escape') event.preventDefault();
          onInput({ type: 'keydown', key: event.key, repeat: event.repeat });
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
          onInput({ type: 'keyup', key: event.key });
        }}
        onClick={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
      >
        <span className="px-hold-label">{buttonLabel}</span>
        <span className="px-hold-sub">{elapsedMs != null ? <span className="px-mono">{formatElapsed(elapsedMs)}</span> : 'Release to stop'}</span>
        <span className="px-hold-meter" aria-hidden="true" />
      </button>
      <div className="px-water-status">
        <p id={statusId} role="status" aria-live="polite" data-slow={view?.slow ? 'true' : undefined}>
          {view?.slow && holding ? 'Waiting for the controller. Water stops on its own if the connection drops.' : message}
        </p>
        {view?.automaticSuspended && holding ? <p className="px-water-note">Automatic watering on this controller is held back while you water by hand, and for its settling time afterwards.</p> : null}
        {view?.releaseToClosedMs != null && view.phase === 'closed' ? <p className="px-water-note px-mono">Release to confirmed close: {view.releaseToClosedMs} ms</p> : null}
        {recheck ? <button type="button" className="px-button is-small" onClick={() => { setView(null); setTakeover(false); setAvailability({ state: 'checking', message: 'Checking the controller…' }); setCheckVersion((version) => version + 1); }}>Check again</button> : null}
      </div>
      <p className="px-water-note">
        Overrides moisture targets, schedules, pauses and automatic-watering rules for this hold only; saved settings are unchanged.
        The controller keeps the valve open only while fresh signals arrive and closes it on its own about 2.5 s after the last one.
        {maxContinuous ? ` Continuous-on limit set on this controller: ${formatElapsed(maxContinuous)}.` : ' No continuous-on limit is configured on this controller.'}
        {' '}“Open” and “closed” are what the controller reports; water flow is not measured.
      </p>
    </section>
  );
}

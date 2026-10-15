import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { HOLD_LIMIT_MS, HoldSession, type HoldView } from './holdSession';
import type { ManualWaterClient, PotRoute } from './manualWaterApi';

type Availability = { state: 'checking' | 'ready' | 'busy' | 'unavailable'; message: string };
const toneFor = (phase: string) => ({ ready: 'ready', watering: 'active', opening: 'active', stopping: 'pending', checking: 'pending', busy: 'pending' } as Record<string, string>)[phase] ?? (['refused', 'unconfirmed', 'unavailable'].includes(phase) ? 'alert' : 'idle');

/** Press and hold to water one pot. The controller owns the valve and ends every hold itself. */
export function HoldWaterControl({ client, pot }: { client: ManualWaterClient; pot: PotRoute }) {
  const [availability, setAvailability] = useState<Availability>({ state: 'checking', message: 'Checking controller…' });
  const [view, setView] = useState<HoldView | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const session = useRef<HoldSession | null>(null);
  const statusId = useId();

  const check = useCallback(async () => {
    setAvailability({ state: 'checking', message: 'Checking controller…' });
    const result = await client.hold('status', pot.pot, crypto.randomUUID(), 0);
    if (!result) return;
    if (!result.ok) { setAvailability({ state: 'unavailable', message: result.error }); return; }
    const reply = result.data;
    if (reply.available === false) setAvailability({ state: 'unavailable', message: 'Hold-to-water is not commissioned on this controller.' });
    else if (reply.ready === false) setAvailability({ state: 'unavailable', message: 'The controller is recovering from a valve fault. Manual watering is paused until it restarts.' });
    else if (reply.busy) setAvailability({ state: 'busy', message: 'Another hold is running on this controller.' });
    else setAvailability({ state: 'ready', message: 'Ready' });
  }, [client, pot.pot]);

  const release = useCallback(() => { session.current?.release(); }, []);

  useEffect(() => {
    void check();
    const hidden = () => { if (document.hidden) release(); };
    window.addEventListener('blur', release);
    window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      release();
      window.removeEventListener('blur', release);
      window.removeEventListener('pagehide', release);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [check, release]);

  useEffect(() => {
    if (view?.phase !== 'watering' || view.openedAt == null) return undefined;
    const openedAt = view.openedAt;
    const timer = window.setInterval(() => setElapsed(Math.min(HOLD_LIMIT_MS, Date.now() - openedAt) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [view?.phase, view?.openedAt]);

  const holding = view != null && ['opening', 'watering'].includes(view.phase);
  const canPress = availability.state === 'ready' && !holding && view?.phase !== 'stopping';
  const press = () => {
    if (!canPress) return;
    setElapsed(0);
    const sessionId = crypto.randomUUID();
    const next = new HoldSession((action, sequence, options) => client.hold(action, pot.pot, sessionId, sequence, options), (state) => {
      if (session.current === next) setView(state);
    });
    session.current = next;
    next.begin();
  };
  const phase = view?.phase ?? availability.state;
  const message = view ? view.message : availability.message;
  const recheck = availability.state === 'unavailable' || availability.state === 'busy' || view?.phase === 'unconfirmed';

  return (
    <section className="px-water" aria-label={`Manual water, pot ${pot.pot}`}>
      <div className="px-water-head">
        <h3>Manual water</h3>
        <span className="px-water-state" data-tone={toneFor(phase)}>{
          { checking: 'Checking', ready: 'Ready', busy: 'In use', unavailable: 'Unavailable', opening: 'Opening', watering: 'Watering',
            stopping: 'Stopping', stopped: 'Stopped', ended: 'Ended', refused: 'Not started', unconfirmed: 'Unconfirmed' }[phase]
        }</span>
      </div>
      <button
        type="button"
        className={`px-hold${holding ? ' is-holding' : ''}${view?.phase === 'watering' ? ' is-watering' : ''}`}
        disabled={!canPress && !holding}
        aria-describedby={statusId}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          press();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onBlur={release}
        onKeyDown={(event) => {
          if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); press(); }
          if (event.key === 'Escape') release();
        }}
        onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); release(); } }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="px-hold-label">{view?.phase === 'watering' ? 'Watering' : view?.phase === 'opening' ? 'Opening…' : 'Hold to water'}</span>
        <span className="px-hold-sub">{view?.phase === 'watering' ? <span className="px-mono">{elapsed.toFixed(1)} s</span> : 'Release to stop'}</span>
        <span className="px-hold-meter" aria-hidden="true" />
      </button>
      <div className="px-water-status">
        <p id={statusId} role="status" aria-live="polite" data-slow={view?.slow ? 'true' : undefined}>
          {view?.slow && holding ? 'Waiting for the controller. Water stops on its own if the connection drops.' : message}
        </p>
        {recheck ? <button type="button" className="px-button is-small" onClick={() => { setView(null); void check(); }}>Check again</button> : null}
      </div>
      <p className="px-water-note">Overrides moisture targets, schedules and watering pauses for this hold only. Saved settings are unchanged. 15-second limit.</p>
    </section>
  );
}

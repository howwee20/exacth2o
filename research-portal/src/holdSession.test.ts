import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldSession, type HoldView } from './holdSession';
import type { ApiResult, HoldReply } from './manualWaterApi';

type Action = 'start' | 'takeover' | 'renew' | 'stop';
type Call = { action: Action; sequence: number; resolve: (result: ApiResult<HoldReply> | null) => void; shouldSend?: () => boolean; keepalive?: boolean };
const reply = (data: HoldReply): ApiResult<HoldReply> => ({ ok: true, data });
const open = (extra: HoldReply = {}) => reply({ status: 'open', ...extra });
const closed = (extra: HoldReply = {}) => reply({ status: 'closed', ...extra });
const lost = (): ApiResult<HoldReply> => ({ ok: false, status: 0, error: 'Controller connection lost', transient: true });

function harness(timing = {}) {
  const calls: Call[] = [];
  const views: HoldView[] = [];
  const session = new HoldSession(
    (action, sequence, options) => new Promise((resolve) => calls.push({ action, sequence, resolve, shouldSend: options.shouldSend, keepalive: options.keepalive })),
    (view) => views.push({ ...view }),
    timing,
  );
  const last = () => views[views.length - 1] ?? session.view;
  return { calls, session, last, of: (action: Action) => calls.filter((call) => call.action === action) };
}

describe('hold-to-water session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps renewing on a fixed rhythm while the controller is slow to answer', async () => {
    const { session, of, last } = harness();
    session.begin();
    await vi.advanceTimersByTimeAsync(1300);
    expect(of('start')).toHaveLength(1);
    expect(of('renew').length).toBeGreaterThanOrEqual(2);
    expect(last().phase).toBe('taking_control');
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('open');
    expect(last().message).toMatch(/controller reports the valve open/);
    session.release();
  });

  it('caps requests in flight when replies stop arriving', async () => {
    const { session, of } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(3000);
    expect(of('renew').length).toBeLessThanOrEqual(4);
    session.release();
  });

  it('ignores a closed reply to a renewal that overtook the start', async () => {
    const { session, of, last } = harness();
    session.begin();
    await vi.advanceTimersByTimeAsync(550);
    of('renew')[0].resolve(closed());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('taking_control');
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('open');
    session.release();
  });

  it('has no fixed maximum: a hold that keeps being renewed stays open well past 15 seconds', async () => {
    const { session, calls, last } = harness();
    session.begin();
    // The controller answers every signal promptly.
    let answered = 0;
    for (let elapsed = 0; elapsed < 60_000; elapsed += 250) {
      while (answered < calls.length) calls[answered++].resolve(open());
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(last().phase).toBe('open');
    expect(last().openedAt).not.toBeNull();
    expect(calls.filter((call) => call.action === 'stop')).toHaveLength(0);
    session.release();
  });

  it('reports the controller ending the hold truthfully, and a stale "open" cannot revive it', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(1100);
    of('renew')[1].resolve(closed({ endReason: 'expired' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('ended');
    expect(last().message).toMatch(/renewals stopped arriving/);
    expect(of('stop')).toHaveLength(1);
    of('renew')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('ended');
  });

  it('explains the continuous-on limit and a takeover by another operator', async () => {
    const limit = harness();
    limit.session.begin();
    limit.of('start')[0].resolve(open({ maxContinuousMilliseconds: 600_000 }));
    await vi.advanceTimersByTimeAsync(600);
    limit.of('renew')[0].resolve(closed({ endReason: 'continuous_limit' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(limit.last().message).toMatch(/continuous-on limit/);
    expect(limit.last().maxContinuousMs).toBe(600_000);

    const preempted = harness();
    preempted.session.begin();
    preempted.of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(600);
    preempted.of('renew')[0].resolve(closed({ endReason: 'preempted' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(preempted.last().message).toMatch(/Another operator took over/);
  });

  it('never sends a start when released before credentials resolve, and renews nothing after', async () => {
    const { session, calls, last } = harness();
    session.begin();
    session.release();
    expect(calls[0].shouldSend?.()).toBe(false);
    calls[0].resolve(null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.filter((call) => call.action === 'renew')).toHaveLength(0);
    expect(last().phase).not.toBe('open');
  });

  it('release stops at once and reports the measured release-to-close time once the controller confirms', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(800);
    const renewalsBefore = of('renew').length;
    session.release();
    expect(last().phase).toBe('stopping');
    expect(of('stop')).toHaveLength(1);
    expect(of('stop')[0].keepalive).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    of('stop')[0].resolve(closed());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('closed');
    expect(last().message).toMatch(/controller reports the valve closed/);
    expect(last().releaseToClosedMs).toBe(120);
    await vi.advanceTimersByTimeAsync(3000);
    expect(of('renew').length).toBe(renewalsBefore);
  });

  it('retries the stop with backoff and says when it cannot be confirmed', async () => {
    const { session, of, last } = harness({ stopAttempts: 3 });
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(10);
    session.release();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(10);
      of('stop')[attempt].resolve(lost());
      await vi.advanceTimersByTimeAsync(4000);
    }
    expect(of('stop')).toHaveLength(3);
    expect(last().phase).toBe('unconfirmed');
    expect(last().message).toMatch(/lease runs out/);
  });

  it('turns a refusal into a stopped hold without retrying the start', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve({ ok: false, status: 403, error: 'Controller operator access required', transient: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('refused');
    expect(last().message).toMatch(/operator access/);
    await vi.advanceTimersByTimeAsync(2000);
    expect(of('start')).toHaveLength(1);
    expect(of('stop')).toHaveLength(1);
  });

  it('reports another operator holding the controller as busy, naming them when known', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(closed({ busy: true, activeOwnerLabel: 'pan' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('busy');
    expect(last().message).toBe('In use by pan.');
  });

  it('a single lost or late signal does not end a healthy hold', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(600);
    of('renew')[0].resolve({ ok: false, status: 409, error: 'Hold signal arrived too late', transient: true, code: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('open');
    of('renew')[1]?.resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('open');
    session.release();
  });

  it('says the connection was lost when confirmations stop, and leaves closing to the controller lease', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(open());
    // Checked on each renewal tick: lease (2.5 s) plus 1.5 s of grace without a confirmation.
    await vi.advanceTimersByTimeAsync(3900);
    expect(last().phase).toBe('open');
    await vi.advanceTimersByTimeAsync(700);
    expect(last().phase).toBe('unconfirmed');
    expect(last().message).toMatch(/Connection lost/);
    expect(of('stop').length).toBeGreaterThanOrEqual(1);
  });

  it('gives up waiting for a start the controller never confirms', async () => {
    const { session, last, of } = harness();
    session.begin();
    await vi.advanceTimersByTimeAsync(5000);
    expect(last().phase).toBe('ended');
    expect(last().message).toMatch(/did not confirm the start/);
    expect(of('stop')).toHaveLength(1);
  });

  it('reports a valve fault instead of watering', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(reply({ status: 'fault', fault: 'close not confirmed on 0x21:26' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('fault');
    expect(last().message).toMatch(/0x21:26/);
  });

  it('closes again if a late reply says the valve is still open after release', async () => {
    const { session, of } = harness();
    session.begin();
    await vi.advanceTimersByTimeAsync(10);
    session.release();
    of('stop')[0].resolve(closed());
    await vi.advanceTimersByTimeAsync(0);
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    expect(of('stop').length).toBe(2);
  });

  it('a takeover press asks the controller to close the other hold first', async () => {
    const { session, of } = harness();
    session.begin('takeover');
    expect(of('takeover')).toHaveLength(1);
    expect(of('start')).toHaveLength(0);
    session.release();
  });
});

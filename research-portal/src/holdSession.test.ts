import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldSession, type HoldView } from './holdSession';
import type { ApiResult, HoldAction, HoldReply } from './manualWaterApi';

type Call = { action: HoldAction; sequence: number; resolve: (result: ApiResult<HoldReply> | null) => void; shouldSend?: () => boolean };
const open = (): ApiResult<HoldReply> => ({ ok: true, data: { status: 'open' } });
const closed = (): ApiResult<HoldReply> => ({ ok: true, data: { status: 'closed' } });

function harness() {
  const calls: Call[] = [];
  const views: HoldView[] = [];
  const session = new HoldSession((action, sequence, options) => new Promise((resolve) => calls.push({ action, sequence, resolve, shouldSend: options.shouldSend })), (view) => views.push(view));
  const last = () => views[views.length - 1];
  return { calls, session, last, of: (action: HoldAction) => calls.filter((call) => call.action === action) };
}

describe('hold-to-water session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps renewing on a fixed rhythm while the controller is slow to answer', async () => {
    const { session, of, last } = harness();
    session.begin();
    await vi.advanceTimersByTimeAsync(1300);
    // Three renewals went out without waiting for the unanswered start.
    expect(of('start')).toHaveLength(1);
    expect(of('renew').length).toBeGreaterThanOrEqual(3);
    expect(last().phase).toBe('opening');
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('watering');
  });

  it('caps requests in flight when replies stop arriving', async () => {
    const { session, of } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(3000);
    expect(of('renew').length).toBeLessThanOrEqual(6);
    session.release();
  });

  it('ignores a closed reply to a renewal that overtook the start', async () => {
    const { session, of, last } = harness();
    session.begin();
    await vi.advanceTimersByTimeAsync(450);
    of('renew')[0].resolve(closed());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('opening');
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('watering');
  });

  it('reports a lapse truthfully when a newer reply says the controller closed the valve', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(900);
    of('renew')[1].resolve(closed());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('ended');
    expect(last().message).toMatch(/connection slowed/);
    expect(of('stop')).toHaveLength(1);
    // A stale "open" afterwards cannot revive it.
    of('renew')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('ended');
  });

  it('never sends a start when released before credentials resolve', async () => {
    const { session, calls, last } = harness();
    session.begin();
    session.release();
    expect(calls[0].shouldSend?.()).toBe(false);
    calls[0].resolve(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((call) => call.action === 'renew')).toHaveLength(0);
    expect(last().phase).not.toBe('watering');
  });

  it('retries stop and reports when the controller cannot confirm it', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    session.release();
    expect(last().phase).toBe('stopping');
    for (let attempt = 0; attempt < 3; attempt++) {
      of('stop')[attempt].resolve({ ok: false, status: 503, error: 'Controller connection lost', transient: true });
      await vi.advanceTimersByTimeAsync(450);
    }
    expect(last().phase).toBe('unconfirmed');
    expect(of('renew')).toHaveLength(0);
  });

  it('confirms stop and sends no renewals after release', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    session.release();
    of('stop')[0].resolve(closed());
    await vi.advanceTimersByTimeAsync(2000);
    expect(last().phase).toBe('stopped');
    expect(of('renew')).toHaveLength(0);
  });

  it('turns a refusal into a stopped hold without retrying the start', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve({ ok: false, status: 409, error: 'Another manual hold is active', transient: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: 'refused', message: 'Another manual hold is active' });
    expect(of('stop')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(of('start')).toHaveLength(1);
  });

  it('a late single signal does not end a healthy hold', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(500);
    of('renew')[0].resolve({ ok: false, status: 409, error: 'Hold signal arrived too late', transient: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe('watering');
    session.release();
  });

  it('ends at the 15-second limit even while the button is held', async () => {
    const { session, of, last } = harness();
    session.begin();
    of('start')[0].resolve(open());
    await vi.advanceTimersByTimeAsync(0);
    for (const call of of('renew')) call.resolve(open());
    await vi.advanceTimersByTimeAsync(15_001);
    expect(last()).toMatchObject({ phase: 'ended' });
    expect(last().message).toMatch(/15-second limit/);
    expect(of('stop').length).toBeGreaterThanOrEqual(1);
  });

  it('gives up waiting for an unconfirmed start', async () => {
    const { session, last, of } = harness();
    session.begin();
    await vi.advanceTimersByTimeAsync(3700);
    expect(last().phase).toBe('ended');
    expect(of('stop')).toHaveLength(1);
  });
});

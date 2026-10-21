import { describe, expect, it, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: {} }));
import { ManualWaterClient, outputName, sameDestination } from './manualWaterApi';

const pot = { kind: 'pot', potNumber: 16 } as const;
const solenoid = { kind: 'solenoid', relayAddress: 33, channel: 26 } as const;

function reply(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('manual watering transport', () => {
  it('reports a failed authentication refresh as recoverable instead of leaving readiness pending', async () => {
    const fetcher = vi.fn();
    const client = new ManualWaterClient('project', 'device', fetcher, async () => { throw new Error('offline'); });
    expect(await client.hold('status', pot, '00000000-0000-4000-8000-000000000001', 0)).toMatchObject({ ok: false, transient: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not send a queued press after it was released during token refresh', async () => {
    const fetcher = vi.fn();
    let held = true;
    const client = new ManualWaterClient('project', 'device', fetcher, async () => { held = false; return 'token'; });
    expect(await client.hold('start', pot, '00000000-0000-4000-8000-000000000001', 1, { shouldSend: () => held })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('names the destination, never a route: a pot by number, a solenoid by board and channel', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply({ status: 'opening', serverTime: Date.now() });
    });
    const client = new ManualWaterClient('project', 'device', fetcher as unknown as typeof fetch, async () => 'token');
    await client.hold('start', pot, 'a', 0);
    await client.hold('start', solenoid, 'b', 0);
    await client.candidateTestClient().hold('start', pot, 'c', 0);
    expect(bodies[0]).toMatchObject({ action: 'start', destination: pot, potNumber: 16, projectId: 'project', deviceId: 'device' });
    expect(bodies[1]).toMatchObject({ destination: solenoid });
    expect(bodies[1].potNumber).toBeUndefined();
    expect(bodies[0].testCandidate).toBeUndefined();
    expect(bodies[2].testCandidate).toBe(true);
    // Press times travel on the server's clock estimate, never a raw local timestamp alone.
    expect(typeof bodies[0].sentAt).toBe('number');
  });

  it('estimates the server clock from replies, so a skewed computer clock neither rejects nor stretches a hold', async () => {
    const skew = 90_000;
    const fetcher = vi.fn(async () => reply({ status: 'open', serverTime: Date.now() + skew }));
    const client = new ManualWaterClient('project', 'device', fetcher as unknown as typeof fetch, async () => 'token');
    await client.hold('status', pot, 'a', 0);
    expect(Math.abs(client.serverNow() - (Date.now() + skew))).toBeLessThan(1000);
  });

  it('treats a late signal and a server or network failure as transient, and a refusal as final', async () => {
    const responses = [
      reply({ error: 'Hold signal arrived too late', code: 'late' }, 409),
      reply({ error: 'Controller response unavailable' }, 503),
      reply({ error: 'Controller operator access required' }, 403),
    ];
    const fetcher = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new TypeError('network down');
      return next;
    });
    const client = new ManualWaterClient('project', 'device', fetcher as unknown as typeof fetch, async () => 'token');
    expect(await client.hold('renew', pot, 'a', 1)).toMatchObject({ ok: false, transient: true, code: 'late' });
    expect(await client.hold('renew', pot, 'a', 2)).toMatchObject({ ok: false, transient: true });
    expect(await client.hold('start', pot, 'b', 0)).toMatchObject({ ok: false, transient: false, status: 403 });
    expect(await client.hold('renew', pot, 'b', 1)).toMatchObject({ ok: false, transient: true, error: 'Controller connection lost' });
  });

  it('labels outputs by their recorded solenoid number, or by board and channel when none is recorded', () => {
    expect(outputName({ solenoidNumber: 74, relayAddress: 33, channel: 26 })).toBe('Solenoid 74');
    expect(outputName({ solenoidNumber: null, relayAddress: 33, channel: 26 })).toBe('Output 0x21:26');
    expect(sameDestination(pot, { kind: 'pot', potNumber: 16 })).toBe(true);
    expect(sameDestination(solenoid, { kind: 'solenoid', relayAddress: 33, channel: 25 })).toBe(false);
    expect(sameDestination(pot, solenoid)).toBe(false);
  });
});

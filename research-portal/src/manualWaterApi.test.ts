import { describe, expect, it, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: {} }));
import { ManualWaterClient } from './manualWaterApi';

describe('manual watering transport', () => {
  it('reports a failed authentication refresh as recoverable instead of leaving readiness pending', async () => {
    const fetcher = vi.fn();
    const client = new ManualWaterClient('project', 'device', fetcher, async () => { throw new Error('offline'); });
    expect(await client.hold('status', 1, 'session', 0)).toMatchObject({ ok: false, transient: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not send a queued press after it was released during token refresh', async () => {
    const fetcher = vi.fn();
    let held = true;
    const client = new ManualWaterClient('project', 'device', fetcher, async () => { held = false; return 'token'; });
    expect(await client.hold('start', 1, 'session', 1, { shouldSend: () => held })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

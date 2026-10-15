import { supabase } from './supabase';

/** One physical pot and the recorded valve route the server will use for it. */
export type PotRoute = {
  pot: number;
  status: 'ready' | 'needs_confirmation' | 'no_water_line' | 'unmapped' | 'conflict';
  relayAddress?: number;
  channel?: number;
  /** Route recorded for a pot that still needs a physical check. */
  candidate?: { relayAddress: number; channel: number } | null;
  /** The sensor pairing on this valve, if any. Its name may not match the physical pot. */
  pairing?: { name: string; sensorKey: string | null; namedPot: number | null } | null;
  source?: string;
  evidence?: string;
  updatedAt?: string;
  reason?: string;
};
export type RouteBook = { pots: PotRoute[]; boards: number[]; canConfirm: boolean };
export type HoldAction = 'start' | 'renew' | 'stop' | 'status';
export type HoldReply = {
  status?: 'open' | 'closed' | 'fault';
  ready?: boolean;
  busy?: boolean;
  available?: boolean;
  error?: string;
  startedAt?: number;
  deadline?: number;
};
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; transient: boolean };

export const routeLabel = (relay: number, channel: number) => `0x${relay.toString(16)} · channel ${channel}`;

/**
 * Client for the manual-hold Edge Function. The browser names a pot number only; the server
 * owns the controller and route. Press times are sent on the server's clock, estimated from
 * each reply, so a fast or slow computer clock cannot reject or stretch a hold.
 */
export class ManualWaterClient {
  private offset = 0;
  private bestRtt = Number.POSITIVE_INFINITY;
  constructor(
    private readonly projectId: string,
    private readonly deviceId: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly token: () => Promise<string | null> = async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
  ) {}

  serverNow() { return Date.now() + this.offset; }

  async post<T>(body: Record<string, unknown>, options: { keepalive?: boolean; timeoutMs?: number; shouldSend?: () => boolean } = {}): Promise<ApiResult<T> | null> {
    const token = await this.token();
    if (!token) return { ok: false, status: 401, error: 'Sign in to water manually', transient: false };
    if (options.shouldSend && !options.shouldSend()) return null;
    const sent = Date.now();
    try {
      const response = await this.fetchImpl(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manual-hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...body, sentAt: body.sentAt ?? this.serverNow(), projectId: this.projectId, deviceId: this.deviceId }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 4500),
        keepalive: options.keepalive,
      });
      const received = Date.now();
      const data = await response.json().catch(() => ({}));
      const rtt = received - sent;
      // The quickest round trip gives the tightest estimate; drift slowly otherwise.
      if (Number.isFinite(data.serverTime) && rtt <= this.bestRtt * 1.5 + 50) {
        this.bestRtt = Math.min(this.bestRtt, rtt);
        this.offset = data.serverTime - (sent + received) / 2;
      }
      // "late" marks one signal that took too long in transit; later signals may still arrive in time.
      if (!response.ok) return { ok: false, status: response.status, error: data.error || 'Controller unavailable', transient: response.status >= 500 || data.code === 'late' };
      return { ok: true, data: data as T };
    } catch {
      return { ok: false, status: 0, error: 'Controller connection lost', transient: true };
    }
  }

  routes() { return this.post<RouteBook>({ action: 'routes' }); }
  confirmRoute(potNumber: number, relayAddress: number, channel: number, note: string) {
    return this.post<RouteBook>({ action: 'confirm_route', potNumber, relayAddress, channel, note });
  }
  removeRoute(potNumber: number) { return this.post<RouteBook>({ action: 'remove_route', potNumber }); }
  hold(action: HoldAction, potNumber: number, sessionId: string, sequence: number, options: { keepalive?: boolean; timeoutMs?: number; shouldSend?: () => boolean } = {}) {
    return this.post<HoldReply>({ action, potNumber, sessionId, sequence, sentAt: this.serverNow() }, options);
  }
}

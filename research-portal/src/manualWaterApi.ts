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

/**
 * One configured valve output (solenoid), identified by its board and channel. The
 * solenoid number is the label recorded for that output, never a display index; the
 * physical pot is known only from a recorded field route.
 */
export type ValveOutput = {
  key: string;
  relayAddress: number;
  channel: number;
  solenoidNumber: number | null;
  labelStatus: 'confirmed' | 'needs_confirmation' | null;
  labelSource: string | null;
  pots: number[];
  candidatePots: number[];
  pairing: { name: string; sensorKey: string | null; namedPot: number | null } | null;
  sharedPairings?: string[];
};

export type RouteBook = {
  pots: PotRoute[];
  outputs: ValveOutput[];
  boards: number[];
  canConfirm: boolean;
  canTakeover: boolean;
  leaseMs: number;
  renewMs: number;
};

export type Destination = { kind: 'pot'; potNumber: number } | { kind: 'solenoid'; relayAddress: number; channel: number };
export type HoldAction = 'start' | 'renew' | 'stop' | 'status' | 'takeover';
export type HoldReply = {
  status?: 'acquiring' | 'opening' | 'open' | 'closed' | 'fault';
  ready?: boolean;
  busy?: boolean;
  available?: boolean;
  error?: string;
  code?: string;
  endReason?: string;
  sequence?: number;
  openedForMs?: number;
  remainingMs?: number;
  leaseMilliseconds?: number;
  maxContinuousMilliseconds?: number | null;
  activeOwnerLabel?: string | null;
  activeRoute?: { relayAddress: number; address: number; label?: string } | null;
  fault?: string;
  configRewrite?: boolean;
  automaticSuspended?: boolean;
  renewMs?: number;
  controllerMs?: number;
};
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; transient: boolean; code?: string };
export type PostOptions = { keepalive?: boolean; timeoutMs?: number; shouldSend?: () => boolean };

export const routeLabel = (relay: number, channel: number) => `0x${relay.toString(16)} · channel ${channel}`;
export const boardLabel = (relay: number) => `0x${relay.toString(16)}`;

export function outputName(output: Pick<ValveOutput, 'solenoidNumber' | 'relayAddress' | 'channel'>) {
  return output.solenoidNumber != null ? `Solenoid ${output.solenoidNumber}` : `Output ${boardLabel(output.relayAddress)}:${output.channel}`;
}

export function sameDestination(a: Destination | null, b: Destination | null) {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'pot' ? a.potNumber === (b as typeof a).potNumber : a.relayAddress === (b as typeof a).relayAddress && a.channel === (b as typeof a).channel;
}

/**
 * Client for the manual-hold Edge Function. The browser names a pot or a configured
 * output; the server resolves the route and owns the controller. Press times are sent
 * on the server's clock, estimated from each reply, so a fast or slow computer clock
 * cannot reject or stretch a hold. Nothing here retries a start or renewal: a lost
 * request is simply superseded by the next fresh signal, never replayed.
 */
export class ManualWaterClient {
  private offset = 0;
  private bestRtt = Number.POSITIVE_INFINITY;
  constructor(
    private readonly projectId: string,
    private readonly deviceId: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly token: () => Promise<string | null> = async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    private readonly testCandidate = false,
  ) {}

  serverNow() { return Date.now() + this.offset; }

  async post<T>(body: Record<string, unknown>, options: PostOptions = {}): Promise<ApiResult<T> | null> {
    try {
      const token = await this.token();
      if (!token) return { ok: false, status: 401, error: 'Sign in to water manually', transient: false };
      if (options.shouldSend && !options.shouldSend()) return null;
      const sent = Date.now();
      const response = await this.fetchImpl(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manual-hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...body, sentAt: body.sentAt ?? this.serverNow(), projectId: this.projectId, deviceId: this.deviceId }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 4500),
        keepalive: options.keepalive,
        cache: 'no-store',
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
      if (!response.ok) return { ok: false, status: response.status, error: data.error || 'Controller unavailable', transient: response.status >= 500 || data.code === 'late', code: data.code };
      return { ok: true, data: data as T };
    } catch {
      return { ok: false, status: 0, error: 'Controller connection lost', transient: true };
    }
  }

  candidateTestClient() { return new ManualWaterClient(this.projectId, this.deviceId, this.fetchImpl, this.token, true); }

  inventory() { return this.post<RouteBook>({ action: 'inventory' }); }
  /** Older name for inventory(). */
  routes() { return this.inventory(); }
  confirmRoute(potNumber: number, relayAddress: number, channel: number, note: string) {
    return this.post<RouteBook>({ action: 'confirm_route', potNumber, relayAddress, channel, note });
  }
  removeRoute(potNumber: number) { return this.post<RouteBook>({ action: 'remove_route', potNumber }); }
  labelOutput(solenoidNumber: number, relayAddress: number, channel: number, note: string) {
    return this.post<RouteBook>({ action: 'label_output', solenoidNumber, relayAddress, channel, note });
  }
  hold(action: HoldAction, destination: Destination | null, sessionId: string, sequence: number, options: PostOptions = {}) {
    return this.post<HoldReply>({
      action,
      sessionId,
      sequence,
      ...(destination ? { destination } : {}),
      ...(destination?.kind === 'pot' ? { potNumber: destination.potNumber } : {}),
      ...(this.testCandidate ? { testCandidate: true } : {}),
    }, options);
  }
}

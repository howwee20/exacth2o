import type { ApiResult, HoldAction, HoldReply } from './manualWaterApi';

export type HoldPhase = 'opening' | 'watering' | 'stopping' | 'stopped' | 'ended' | 'refused' | 'unconfirmed';
export type HoldView = { phase: HoldPhase; message: string; openedAt: number | null; slow: boolean };
type Send = (action: HoldAction, sequence: number, options: { keepalive?: boolean; timeoutMs?: number; shouldSend?: () => boolean }) => Promise<ApiResult<HoldReply> | null>;

export const HOLD_LIMIT_MS = 15_000;
const RENEW_MS = 400;
const MAX_IN_FLIGHT = 6;
const SLOW_AFTER_MS = 1600;
const START_CONFIRM_MS = 3500;
const STOP_ATTEMPTS = 3;

/**
 * One press of the hold button. Renewals go out on a fixed rhythm instead of waiting for each
 * reply, so a slow round trip does not starve the controller lease; the controller keeps only
 * the newest sequence. Releasing sends stop, retried until the controller confirms it.
 */
export class HoldSession {
  private sequence = 0;
  private inFlight = 0;
  private released = false;
  private finished = false;
  private confirmedOpen = false;
  private openSequence = -1;
  private lastReplyAt = Date.now();
  private beganAt = Date.now();
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  view: HoldView = { phase: 'opening', message: 'Opening valve…', openedAt: null, slow: false };

  constructor(private readonly send: Send, private readonly onChange: (view: HoldView) => void) {}

  private update(next: Partial<HoldView>) {
    this.view = { ...this.view, ...next };
    this.onChange(this.view);
  }

  private stopRenewing() {
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.renewTimer = null;
    this.limitTimer = null;
  }

  begin() {
    this.beganAt = Date.now();
    this.update({});
    void this.request('start');
    this.renewTimer = setInterval(() => {
      if (this.inFlight < MAX_IN_FLIGHT) void this.request('renew');
      if (!this.confirmedOpen && Date.now() - this.beganAt > START_CONFIRM_MS) {
        this.end('The controller did not confirm the start. Release and try again.');
        return;
      }
      const silent = Date.now() - this.lastReplyAt > SLOW_AFTER_MS;
      if (silent !== this.view.slow && !this.released) this.update({ slow: silent });
    }, RENEW_MS);
    this.limitTimer = setTimeout(() => this.end('15-second limit reached. Release, then hold again to continue.'), HOLD_LIMIT_MS);
  }

  private async request(action: 'start' | 'renew') {
    if (this.released) return;
    const sequence = this.sequence++;
    this.inFlight++;
    const result = await this.send(action, sequence, { timeoutMs: 4000, shouldSend: () => !this.released });
    this.inFlight--;
    if (!result || this.released) return;
    this.lastReplyAt = Date.now();
    if (!result.ok) {
      // A refusal is final; a lost or slow reply is not — the lease ends the hold if they keep failing.
      if (!result.transient) this.refuse(result.error);
      return;
    }
    const reply = result.data;
    if (reply.status === 'fault') { this.refuse('Valve fault. The controller is retrying the close; check the outlet.'); return; }
    if (reply.status === 'open') {
      if (sequence > this.openSequence) this.openSequence = sequence;
      if (!this.confirmedOpen) {
        this.confirmedOpen = true;
        this.update({ phase: 'watering', message: 'Watering · controller confirmed', openedAt: Date.now(), slow: false });
      } else if (this.view.slow) this.update({ slow: false });
      return;
    }
    // Closed: a renewal can overtake the start, so only a start reply or a newer reply after
    // the valve was confirmed open means the controller has ended this hold.
    if (action === 'start' && !this.confirmedOpen) { this.end('The controller did not open the valve. Release and try again.'); return; }
    if (this.confirmedOpen && sequence > this.openSequence) {
      this.end('Hold ended by the controller after the connection slowed. Release, then hold again.');
    }
  }

  private refuse(message: string) {
    if (this.finished) return;
    this.finished = true;
    this.stopRenewing();
    this.update({ phase: 'refused', message, slow: false });
    void this.sendStop(false);
  }

  /** The hold ended while the button is still pressed. */
  private end(message: string) {
    if (this.finished) return;
    this.finished = true;
    this.stopRenewing();
    this.update({ phase: 'ended', message, slow: false });
    void this.sendStop(false);
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.stopRenewing();
    if (this.finished) return;
    this.finished = true;
    if (this.sequence === 0) { this.update({ phase: 'stopped', message: 'Released before watering started.', slow: false }); return; }
    this.update({ phase: 'stopping', message: 'Stopping…', slow: false });
    void this.sendStop(true);
  }

  private async sendStop(report: boolean) {
    this.released = true;
    for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt++) {
      const result = await this.send('stop', this.sequence++, { keepalive: true, timeoutMs: 4000 });
      if (result?.ok && result.data.status === 'closed') {
        if (report) this.update({ phase: 'stopped', message: 'Stopped · controller confirmed' });
        return true;
      }
      if (result && !result.ok && !result.transient) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (report) this.update({ phase: 'unconfirmed', message: 'Stop not yet confirmed. The controller ends the hold on its own within 3 seconds; check the outlet.' });
    return false;
  }
}

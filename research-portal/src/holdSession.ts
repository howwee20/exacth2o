import type { ApiResult, HoldReply, PostOptions } from './manualWaterApi';

export type HoldPhase =
  | 'taking_control'
  | 'opening'
  | 'open'
  | 'stopping'
  | 'closed'
  | 'ended'
  | 'refused'
  | 'busy'
  | 'unconfirmed'
  | 'fault';

export type HoldView = {
  phase: HoldPhase;
  message: string;
  /** Local monotonic time the controller reported the valve open (for elapsed time). */
  openedAt: number | null;
  slow: boolean;
  busyLabel: string | null;
  maxContinuousMs: number | null;
  automaticSuspended: boolean;
  /** Release-to-confirmed-close latency measured in this browser, once known. */
  releaseToClosedMs: number | null;
};

type Send = (action: 'start' | 'takeover' | 'renew' | 'stop', sequence: number, options: PostOptions) => Promise<ApiResult<HoldReply> | null>;

export type HoldTiming = {
  renewMs: number;
  leaseMs: number;
  maxInFlight: number;
  slowAfterMs: number;
  startConfirmMs: number;
  stopAttempts: number;
};

export const defaultHoldTiming: HoldTiming = {
  renewMs: 500,
  leaseMs: 2500,
  maxInFlight: 4,
  slowAfterMs: 1600,
  // Taking manual control may first close an automatic valve on the controller.
  startConfirmMs: 4500,
  stopAttempts: 5,
};

const endedMessages: Record<string, string> = {
  expired: 'The controller ended the hold: its renewals stopped arriving in time. Release, then hold again.',
  continuous_limit: 'The controller ended the hold at the valve’s continuous-on limit. Release, then hold again after it rests.',
  preempted: 'Another operator took over the controller. Your hold was closed first.',
  controller_stop: 'The controller ended the hold because its state changed.',
  recovered_after_restart: 'The controller restarted and closed the valve.',
  start_failed: 'The controller could not open the valve.',
};

/**
 * One deliberate press of the hold control. Renewals go out on a fixed rhythm instead
 * of waiting for each reply, so a slow round trip does not starve the controller's
 * short lease; the controller keeps only the newest sequence and never opens twice.
 * There is no fixed maximum length: the hold lasts while the press, the connection
 * and the controller do. Releasing sends stop, retried until the controller confirms
 * it. Nothing after an end (release, expiry, refusal, fault, lost connection) can
 * start water again: a new press is a new session.
 */
export class HoldSession {
  private sequence = 0;
  private inFlight = 0;
  private released = false;
  private finished = false;
  private confirmedOpen = false;
  private openSequence = -1;
  private lastReplyAt: number;
  private lastOpenReplyAt: number;
  private beganAt: number;
  private releasedAt: number | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private readonly timing: HoldTiming;
  view: HoldView = { phase: 'taking_control', message: 'Taking manual control…', openedAt: null, slow: false, busyLabel: null, maxContinuousMs: null, automaticSuspended: false, releaseToClosedMs: null };

  constructor(
    private readonly send: Send,
    private readonly onChange: (view: HoldView) => void,
    timing: Partial<HoldTiming> = {},
    private readonly now: () => number = () => performance.now(),
  ) {
    this.timing = { ...defaultHoldTiming, ...timing };
    this.lastReplyAt = this.now();
    this.lastOpenReplyAt = this.now();
    this.beganAt = this.now();
  }

  get active() {
    return !this.finished;
  }

  private update(next: Partial<HoldView>) {
    this.view = { ...this.view, ...next };
    this.onChange(this.view);
  }

  private stopRenewing() {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  begin(action: 'start' | 'takeover' = 'start') {
    this.beganAt = this.now();
    this.lastReplyAt = this.beganAt;
    this.lastOpenReplyAt = this.beganAt;
    this.update({});
    void this.request(action);
    this.renewTimer = setInterval(() => this.tick(), this.timing.renewMs);
  }

  private tick() {
    if (this.finished) return;
    if (this.inFlight < this.timing.maxInFlight) void this.request('renew');
    const now = this.now();
    if (!this.confirmedOpen && now - this.beganAt > this.timing.startConfirmMs) {
      this.end('The controller did not confirm the start in time. Release and try again.', 'ended');
      return;
    }
    if (this.confirmedOpen && now - this.lastOpenReplyAt > this.timing.leaseMs + 1500) {
      // The controller's lease has run out without a renewal it confirmed: it has closed
      // the valve on its own, but this browser cannot confirm that until it reconnects.
      this.end('Connection lost. The controller closes the valve on its own when its 2.5-second lease runs out; closure will be confirmed when the connection returns.', 'unconfirmed');
      return;
    }
    const silent = now - this.lastReplyAt > this.timing.slowAfterMs;
    if (silent !== this.view.slow) this.update({ slow: silent });
  }

  private async request(action: 'start' | 'takeover' | 'renew') {
    if (this.released || this.finished) return;
    const sequence = this.sequence++;
    this.inFlight++;
    const result = await this.send(action, sequence, { timeoutMs: 4000, shouldSend: () => !this.released && !this.finished });
    this.inFlight--;
    if (!result) return;
    if (this.finished || this.released) {
      // A late reply after the hold ended: if the controller still says open, close it again.
      if (result.ok && result.data.status === 'open') void this.sendStop(false);
      return;
    }
    this.lastReplyAt = this.now();
    if (!result.ok) {
      if (result.code === 'busy' || /another manual hold/i.test(result.error)) {
        this.finish('busy', `${result.error}.`, { busyLabel: null });
        return;
      }
      // A refusal is final; a lost, slow or late signal is not — the lease ends the hold if they keep failing.
      if (!result.transient) this.refuse(result.error);
      return;
    }
    const reply = result.data;
    if (reply.maxContinuousMilliseconds !== undefined && reply.maxContinuousMilliseconds !== this.view.maxContinuousMs) this.update({ maxContinuousMs: reply.maxContinuousMilliseconds ?? null });
    if (reply.automaticSuspended && !this.view.automaticSuspended) this.update({ automaticSuspended: true });
    if (reply.status === 'fault') { this.refuse(reply.fault ? `Valve fault: ${reply.fault}` : 'Valve fault. The controller is retrying the close; check the outlet.', 'fault'); return; }
    if (reply.busy && !this.confirmedOpen && reply.status !== 'open') {
      this.finish('busy', reply.activeOwnerLabel ? `In use by ${reply.activeOwnerLabel}.` : 'Another operator is holding a valve on this controller.', { busyLabel: reply.activeOwnerLabel ?? null });
      void this.sendStop(false);
      return;
    }
    if (reply.status === 'open') {
      if (sequence > this.openSequence) this.openSequence = sequence;
      this.lastOpenReplyAt = this.now();
      if (!this.confirmedOpen) {
        this.confirmedOpen = true;
        const openedFor = Number.isFinite(reply.openedForMs) ? Number(reply.openedForMs) : 0;
        this.update({ phase: 'open', message: 'Watering · the controller reports the valve open', openedAt: this.now() - openedFor, slow: false });
      } else if (this.view.slow) this.update({ slow: false });
      return;
    }
    if (reply.status === 'acquiring' || reply.status === 'opening') {
      if (!this.confirmedOpen && this.view.phase !== 'opening') this.update({ phase: 'opening', message: 'Opening the valve…' });
      return;
    }
    // Closed: a renewal can overtake the start, so only a start reply, or a newer reply
    // after the valve was confirmed open, means the controller has ended this hold.
    if ((action === 'start' || action === 'takeover') && !this.confirmedOpen) {
      this.end(endedMessages[reply.endReason ?? ''] ?? 'The controller did not open the valve. Release and try again.', 'ended');
      return;
    }
    if (this.confirmedOpen && sequence > this.openSequence) {
      this.end(endedMessages[reply.endReason ?? ''] ?? 'The controller ended the hold. Release, then hold again.', 'ended');
    }
  }

  private finish(phase: HoldPhase, message: string, extra: Partial<HoldView> = {}) {
    if (this.finished) return;
    this.finished = true;
    this.stopRenewing();
    this.update({ phase, message, slow: false, ...extra });
  }

  private refuse(message: string, phase: HoldPhase = 'refused') {
    if (this.finished) return;
    this.finish(phase, message);
    void this.sendStop(false);
  }

  /** The hold ended while the control is still pressed. */
  private end(message: string, phase: HoldPhase) {
    if (this.finished) return;
    this.finish(phase, message);
    void this.sendStop(phase === 'unconfirmed');
  }

  /** The operator let go (or the input was interrupted). */
  release(reason = 'Released') {
    if (this.released) return;
    this.released = true;
    this.releasedAt = this.now();
    this.stopRenewing();
    if (this.finished) return;
    this.finished = true;
    if (this.sequence === 0) { this.update({ phase: 'closed', message: 'Released before watering started.', slow: false }); return; }
    this.update({ phase: 'stopping', message: reason === 'Released' ? 'Stopping…' : `${reason}. Stopping…`, slow: false });
    void this.sendStop(true);
  }

  private async sendStop(report: boolean) {
    this.released = true;
    let delay = 400;
    for (let attempt = 0; attempt < this.timing.stopAttempts; attempt++) {
      const result = await this.send('stop', this.sequence++, { keepalive: true, timeoutMs: 5000 });
      if (result?.ok && result.data.status === 'closed') {
        if (report) {
          const latency = this.releasedAt != null ? Math.round(this.now() - this.releasedAt) : null;
          this.update({ phase: 'closed', message: 'Stopped · the controller reports the valve closed', releaseToClosedMs: latency });
        }
        return true;
      }
      if (result?.ok && result.data.status === 'fault') {
        if (report) this.update({ phase: 'fault', message: result.data.fault ? `Valve fault: ${result.data.fault}` : 'Valve fault: the close was not confirmed. The controller keeps retrying; check the outlet.' });
        return false;
      }
      if (result && !result.ok && !result.transient) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(3000, delay * 2);
    }
    if (report) this.update({ phase: 'unconfirmed', message: 'Stop not yet confirmed. The controller closes the valve on its own when its 2.5-second lease runs out; check the outlet.' });
    return false;
  }
}

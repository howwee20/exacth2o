// Single arbitration policy for the controller's one shared valve output lock.
//
// StateMachine keeps the lock itself (openValvePairId). Every path that wants to
// open an output asks this policy first: automatic watering, timed manual pulses
// (autocalibration and bounded manual_water commands), hold-to-water sessions and
// topology rewrites. The policy never opens or closes a relay; it only answers
// "may this path proceed now, and if not, why".
//
// Ordinary pauses (watering disabled, sensing-only experiments, schedules) are not
// modelled here at all: they belong to the automatic path. What is modelled are
// the states that must stop every new opening: a valve whose closure could not be
// confirmed (fault), a topology rewrite in progress, and an operator who has taken
// manual control.

export type ManualControl = {
  sessionId: string
  ownerId: string
  // Monotonic milliseconds.
  since: number
}

export type ConfigRewrite = {
  id: string
  since: number
  until: number
}

export type ArbiterFault = {
  reason: string
  at: number
  source: 'close_failed' | 'watchdog' | 'recovery'
}

export type ArbiterDecision = { allowed: true } | { allowed: false; reason: string; retryInMs: number | null }

export const DEFAULT_MANUAL_SETTLE_MS = 60_000
export const DEFAULT_PULSE_QUIET_AFTER_MANUAL_MS = 120_000
export const MAX_CONFIG_REWRITE_MS = 5 * 60_000

export class ValveArbiter {
  private manual: ManualControl | null = null
  private manualEndedAt: number | null = null
  private rewrite: ConfigRewrite | null = null
  private faultState: ArbiterFault | null = null

  constructor(
    private readonly mono: () => number,
    private readonly manualSettleMs = DEFAULT_MANUAL_SETTLE_MS,
    private readonly pulseQuietMs = DEFAULT_PULSE_QUIET_AFTER_MANUAL_MS,
  ) {}

  get manualControl(): ManualControl | null {
    return this.manual
  }

  get fault(): ArbiterFault | null {
    return this.faultState
  }

  get configRewrite(): ConfigRewrite | null {
    this.expireRewrite()
    return this.rewrite
  }

  private expireRewrite() {
    if (this.rewrite && this.mono() >= this.rewrite.until) this.rewrite = null
  }

  /** A manual session is about to acquire the output. Automatic starts and timed pulses wait. */
  beginManualControl(sessionId: string, ownerId: string) {
    this.manual = { sessionId, ownerId, since: this.mono() }
    this.manualEndedAt = null
  }

  /** Ends manual control for that session only; a delayed end from an old session is ignored. */
  endManualControl(sessionId: string) {
    if (this.manual?.sessionId !== sessionId) return
    this.manual = null
    this.manualEndedAt = this.mono()
  }

  recordFault(reason: string, source: ArbiterFault['source']) {
    this.faultState = { reason, at: this.mono(), source }
  }

  /** Only called after every output is independently confirmed closed. */
  clearFault() {
    this.faultState = null
  }

  beginConfigRewrite(id: string, ttlMs: number): ArbiterDecision {
    this.expireRewrite()
    if (this.faultState) return { allowed: false, reason: `valve fault: ${this.faultState.reason}`, retryInMs: null }
    if (this.manual) return { allowed: false, reason: 'manual watering is in progress; release it before changing the topology', retryInMs: 2_000 }
    if (this.rewrite && this.rewrite.id !== id) return { allowed: false, reason: 'another topology change is in progress', retryInMs: 2_000 }
    const now = this.mono()
    const ttl = Math.max(1_000, Math.min(MAX_CONFIG_REWRITE_MS, Number(ttlMs) || 60_000))
    this.rewrite = { id, since: this.rewrite?.since ?? now, until: now + ttl }
    return { allowed: true }
  }

  endConfigRewrite(id: string) {
    if (this.rewrite?.id === id) this.rewrite = null
  }

  /** Automatic irrigation may open a valve. Manual control and its settling window take priority. */
  automaticOpen(): ArbiterDecision {
    this.expireRewrite()
    if (this.faultState) return { allowed: false, reason: `valve fault: ${this.faultState.reason}`, retryInMs: null }
    if (this.rewrite) return { allowed: false, reason: 'topology change in progress', retryInMs: Math.max(1_000, this.rewrite.until - this.mono()) }
    if (this.manual) return { allowed: false, reason: 'manual troubleshooting in progress', retryInMs: 30_000 }
    if (this.manualEndedAt != null) {
      const wait = this.manualEndedAt + this.manualSettleMs - this.mono()
      if (wait > 0) return { allowed: false, reason: 'settling after manual watering', retryInMs: wait }
    }
    return { allowed: true }
  }

  /** A timed pulse (autocalibration or a bounded manual_water command) may open a valve. */
  timedPulse(): ArbiterDecision {
    this.expireRewrite()
    if (this.faultState) return { allowed: false, reason: `valve fault: ${this.faultState.reason}`, retryInMs: null }
    if (this.rewrite) return { allowed: false, reason: 'topology change in progress', retryInMs: null }
    if (this.manual) return { allowed: false, reason: 'manual troubleshooting in progress', retryInMs: null }
    if (this.manualEndedAt != null) {
      const wait = this.manualEndedAt + this.pulseQuietMs - this.mono()
      if (wait > 0) return { allowed: false, reason: 'manual watering just ended; sensor readings are still settling', retryInMs: wait }
    }
    return { allowed: true }
  }

  /** A hold session may start acquiring the output. Busy holds are decided by the hold manager. */
  holdStart(): ArbiterDecision {
    this.expireRewrite()
    if (this.faultState) return { allowed: false, reason: `valve fault: ${this.faultState.reason}`, retryInMs: null }
    if (this.rewrite) return { allowed: false, reason: 'a topology change is being applied; manual watering resumes when it finishes', retryInMs: Math.max(1_000, this.rewrite.until - this.mono()) }
    return { allowed: true }
  }

  snapshot() {
    this.expireRewrite()
    const now = this.mono()
    return {
      manualControl: this.manual ? { sessionId: this.manual.sessionId, ownerId: this.manual.ownerId, forMs: now - this.manual.since } : null,
      manualSettlingForMs: this.manualEndedAt != null ? Math.max(0, this.manualEndedAt + this.manualSettleMs - now) : 0,
      timedPulseQuietForMs: this.manualEndedAt != null ? Math.max(0, this.manualEndedAt + this.pulseQuietMs - now) : 0,
      configRewrite: this.rewrite ? { id: this.rewrite.id, forMs: now - this.rewrite.since, expiresInMs: this.rewrite.until - now } : null,
      fault: this.faultState ? { reason: this.faultState.reason, source: this.faultState.source, agoMs: now - this.faultState.at } : null,
    }
  }
}

/** Monotonic milliseconds (CLOCK_MONOTONIC): unaffected by wall-clock steps or NTP slews. */
export function monotonicMs(): number {
  const [seconds, nanoseconds] = process.hrtime()
  return seconds * 1000 + nanoseconds / 1e6
}

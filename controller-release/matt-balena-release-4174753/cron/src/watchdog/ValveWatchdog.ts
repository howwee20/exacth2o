// Independent valve watchdog. Runs as its own process (and container), never inside
// cron_svc, so a crash, event-loop stall or hung I2C write in cron cannot also stop
// this timer.
//
// It polls cron's read-only ownership snapshot. While cron answers, cron's own
// deadline is authoritative. If cron stops answering while an output is open, or
// keeps reporting an output past its deadline, the watchdog drives every relay
// board's RESET line low: the I/O expanders return to their power-on state, which
// is all relays off on these active-low boards. The lockout is kept (re-asserted on
// every tick, including across cron restarts) until cron has acknowledged the trip
// and an operator has reconciled it.
//
// Limits it cannot remove, stated for bench verification: it needs this process and
// the RESET wiring to work, and it acts only after the owner's deadline plus a grace
// period. Power loss and a stuck-open valve body are physical failure modes.

export type OwnerKind = 'automatic' | 'pulse' | 'hold'

export type ArbiterStatus = {
  watchdogReconciled?: boolean
  owner: { key: string; kind: OwnerKind | null; deadlineInMs: number | null } | null
  arbiter?: { fault?: { reason: string; source: string } | null }
}

export interface WatchdogIO {
  mono(): number
  poll(): Promise<ArbiterStatus>
  assertReset(): void
  releaseReset(): void
  notifyTrip(reason: string): Promise<void>
  save(state: WatchdogState): void
  log(message: string): void
}

export type WatchdogState = {
  tripped: boolean
  reason: string | null
  trippedAtWall: string | null
  acknowledged: boolean
}

export type WatchdogOptions = {
  holdGraceMs?: number
  pulseGraceMs?: number
  automaticGraceMs?: number
  /** An automatic pulse without a reported close time is given this long. */
  automaticUnknownMs?: number
}

export class ValveWatchdog {
  state: WatchdogState
  private tracked: { key: string; kind: OwnerKind | null; deadlineMono: number } | null = null
  private firstOverdueMono: number | null = null
  private missingSince: number | null = null
  private hasSeenStatus = false
  private readonly holdGraceMs: number
  private readonly pulseGraceMs: number
  private readonly automaticGraceMs: number
  private readonly automaticUnknownMs: number

  constructor(private readonly io: WatchdogIO, initial: WatchdogState | null = null, options: WatchdogOptions = {}) {
    this.state = initial ?? { tripped: false, reason: null, trippedAtWall: null, acknowledged: false }
    this.holdGraceMs = options.holdGraceMs ?? 1_500
    this.pulseGraceMs = options.pulseGraceMs ?? 5_000
    this.automaticGraceMs = options.automaticGraceMs ?? 120_000
    this.automaticUnknownMs = options.automaticUnknownMs ?? 300_000
    if (this.state.tripped) this.io.assertReset()
  }

  private grace(kind: OwnerKind | null) {
    if (kind === 'hold') return this.holdGraceMs
    if (kind === 'pulse') return this.pulseGraceMs
    return this.automaticGraceMs
  }

  private trip(reason: string) {
    this.io.assertReset()
    if (this.state.tripped) return
    this.state = { tripped: true, reason, trippedAtWall: new Date().toISOString(), acknowledged: false }
    this.io.save(this.state)
    this.io.log(`Valve watchdog tripped: ${reason}. Every relay board RESET is held low until reconciliation.`)
  }

  async tick() {
    const now = this.io.mono()
    let status: ArbiterStatus | null = null
    try {
      status = await this.io.poll()
    } catch {
      status = null
    }

    if (this.state.tripped) {
      // Keep the lockout asserted: a restarting cron re-initializes its boards.
      this.io.assertReset()
      if (!status) return
      const fault = status.arbiter?.fault
      if (!this.state.acknowledged) {
        if (fault?.source === 'watchdog') {
          this.state = { ...this.state, acknowledged: true }
          this.io.save(this.state)
        } else {
          await this.io.notifyTrip(this.state.reason ?? 'lease overrun').catch(() => undefined)
        }
        return
      }
      if (!fault && !status.owner && status.watchdogReconciled === true) {
        // cron acknowledged the trip and an operator reconciled it after checking every outlet.
        this.io.releaseReset()
        this.io.log('Valve watchdog released after reconciliation.')
        this.state = { tripped: false, reason: null, trippedAtWall: null, acknowledged: false }
        this.tracked = null
        this.io.save(this.state)
      }
      return
    }

    if (status) {
      this.hasSeenStatus = true
      this.missingSince = null
      const owner = status.owner
      if (!owner) {
        this.tracked = null
        this.firstOverdueMono = null
        return
      }
      const sameOwner = this.tracked?.key === owner.key
      const deadlineMono = owner.deadlineInMs != null
        ? now + owner.deadlineInMs
        : sameOwner
          ? this.tracked!.deadlineMono
          : now + this.automaticUnknownMs
      this.tracked = { key: owner.key, kind: owner.kind, deadlineMono }
      if (owner.deadlineInMs === 0) {
        // cron is alive but still reports the output past its own deadline: a close that
        // keeps failing, or a timer that never fired.
        if (!sameOwner || this.firstOverdueMono == null) this.firstOverdueMono = now
        if (now - this.firstOverdueMono > this.grace(owner.kind)) {
          this.trip(`${owner.kind ?? 'unknown'} output ${owner.key} reported past its deadline for more than ${this.grace(owner.kind)} ms`)
        }
      } else {
        this.firstOverdueMono = null
      }
      return
    }

    // A crash can occur between the last idle poll and the next poll after OPEN.
    // Missing telemetry is not proof that the outputs are closed. Give initial
    // controller startup three minutes; after a healthy poll, fail closed in 5 s
    // even if the watchdog never observed the opening.
    this.missingSince ??= now
    if (!this.tracked && now - this.missingSince > (this.hasSeenStatus ? 5_000 : 180_000)) {
      this.trip('cron_svc unresponsive; valve ownership cannot be established')
      return
    }
    // cron did not answer.
    if (this.tracked && now > this.tracked.deadlineMono + this.grace(this.tracked.kind)) {
      this.trip(`cron_svc unresponsive while ${this.tracked.kind ?? 'an'} output ${this.tracked.key} was open past its deadline`)
    }
  }

}

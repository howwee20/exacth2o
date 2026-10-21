import { readFile, writeFile, rename } from 'fs/promises'
import { monotonicMs } from './ValveArbiter'

// Controller-owned hold-to-water sessions.
//
// A session is opened once and kept open only by fresh renewals: each accepted
// signal extends a short lease measured on this process's monotonic clock. When
// renewals stop arriving the lease ends here, on the controller, whatever happened
// to the browser, the Edge Function or the network. There is no fixed maximum hold
// length unless the hardware needs one (maxContinuousMs, configured from the valve
// and supply ratings). Renewals never touch the relay, so a long hold does not
// chatter the valve.
//
// Invariants (each has a test):
//  - A stop that arrives before its start leaves a tombstone, so the late start
//    never opens the valve.
//  - A terminal session is never reopened by a delayed start or renewal.
//  - A renewal cannot create a session, change its output, or extend another
//    operator's session.
//  - A stop for an old session cannot close a newer session's valve.
//  - A renewal or start that is already late in transit cannot extend the lease,
//    and no signal can push the lease further than leaseMs past its arrival, so a
//    skewed clock elsewhere cannot stretch it.
//  - Stop and expiry close the relay before anything is written to disk.
//  - Tombstones are retained by the time a session ended, not when it started, so
//    a long hold is still remembered after it ends.

export type HoldRoute = { relayAddress: number; address: number; kind: 'pot' | 'solenoid'; label?: string }

export interface HoldSignal {
  sessionId: string
  ownerId: string
  sequence: number
  /** Wall-clock time (ms) after which the sender considers this signal stale. */
  expiresAt: number
  route: HoldRoute
  /** The sender authorized ending another operator's session first. */
  takeover?: boolean
}

export type HoldAction = 'start' | 'renew' | 'stop' | 'status'

export type EndReason =
  | 'released'
  | 'expired'
  | 'stopped_before_start'
  | 'preempted'
  | 'start_failed'
  | 'continuous_limit'
  | 'controller_stop'
  | 'recovered_after_restart'

type SessionStatus = 'acquiring' | 'opening' | 'open' | 'fault'

export interface HoldSession {
  sessionId: string
  ownerId: string
  route: HoldRoute
  sequence: number
  status: SessionStatus
  startedAt: number
  startedMono: number
  openedMono: number | null
  deadlineMono: number
  renewals: number
  ended: EndReason | null
  /** Resolves when this session's start flow has finished acquiring (or failed to). */
  settled?: Promise<void>
  /** The one close attempt in progress for this session, shared by every caller. */
  closing?: Promise<void>
}

interface Tombstone {
  sessionId: string
  ownerId: string
  status: 'closed' | 'fault'
  reason: EndReason
  endedAt: number
  route: HoldRoute | null
  openedForMs: number | null
}

interface PersistedState {
  version: 2
  active: Pick<HoldSession, 'sessionId' | 'ownerId' | 'route' | 'startedAt'> | null
  tombstones: Tombstone[]
}

export interface HoldReply {
  status: 'acquiring' | 'opening' | 'open' | 'closed' | 'fault'
  sessionId: string
  ready: boolean
  busy: boolean
  endReason?: EndReason
  late?: boolean
  sequence?: number
  openedForMs?: number
  remainingMs?: number
  leaseMilliseconds: number
  maxContinuousMilliseconds: number | null
  activeOwnerId?: string
  activeRoute?: HoldRoute
  controllerTime: number
}

export interface HoldCallbacks {
  /** Take exclusive ownership of the output (closing automatic watering or a timed pulse first). */
  acquire: (session: HoldSession) => Promise<void>
  open: (session: HoldSession) => Promise<void> | void
  /** Close the output, with the controller's normal retries and close-all fallback. Throws if unconfirmed. */
  close: (session: HoldSession) => Promise<void> | void
  /** Give the output back after a confirmed close (or after a start that never opened). */
  release: (session: HoldSession, reason: EndReason) => void
  /** A close could not be confirmed: the output stays owned and every new opening is refused. */
  onFault?: (session: HoldSession, error: unknown) => void
}

export interface HoldOptions {
  leaseMs?: number
  maxContinuousMs?: number | null
  closeRetryMs?: number
  tombstoneMs?: number
  maxTombstones?: number
  now?: () => number
  mono?: () => number
  /** Test seams for slow or failing storage; default to the file system with atomic renames. */
  write?: (file: string, body: string) => Promise<void>
  read?: (file: string) => Promise<string | null>
}

async function readIfPresent(file: string) {
  try {
    return await readFile(file, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function atomicWrite(file: string, body: string) {
  await writeFile(`${file}.tmp`, body, { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

export class HoldError extends Error {
  constructor(message: string, readonly code: 'busy' | 'late' | 'invalid' | 'owner' | 'route' | 'unavailable' | 'failed') {
    super(message)
    this.name = 'HoldError'
  }
}

const sessionPattern = /^[a-zA-Z0-9-]{16,80}$/

export class ManualHoldManager {
  readonly leaseMs: number
  readonly maxContinuousMs: number | null
  private readonly closeRetryMs: number
  private readonly tombstoneMs: number
  private readonly maxTombstones: number
  private readonly now: () => number
  private readonly mono: () => number
  private readonly write: (file: string, body: string) => Promise<void>
  private readonly read: (file: string) => Promise<string | null>

  private active: HoldSession | null = null
  private tombstones = new Map<string, Tombstone>()
  private ready = false
  private faultSession: HoldSession | null = null
  private faultResolved = false
  private expiryTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writePending = false

  constructor(private readonly file: string, private readonly callbacks: HoldCallbacks, options: HoldOptions = {}) {
    this.leaseMs = Math.max(500, Math.min(10_000, options.leaseMs ?? 2_500))
    this.maxContinuousMs = options.maxContinuousMs != null && options.maxContinuousMs > 0 ? options.maxContinuousMs : null
    this.closeRetryMs = options.closeRetryMs ?? 1_000
    this.tombstoneMs = options.tombstoneMs ?? 10 * 60_000
    this.maxTombstones = options.maxTombstones ?? 2_000
    this.now = options.now ?? Date.now
    this.mono = options.mono ?? monotonicMs
    this.write = options.write ?? atomicWrite
    this.read = options.read ?? readIfPresent
  }

  // ---------------------------------------------------------------- persistence

  private persistedState(): PersistedState {
    const active = this.active ?? this.faultSession
    return {
      version: 2,
      active: active ? { sessionId: active.sessionId, ownerId: active.ownerId, route: active.route, startedAt: active.startedAt } : null,
      tombstones: Array.from(this.tombstones.values()),
    }
  }

  private prune() {
    const cutoff = this.now() - this.tombstoneMs
    for (const [id, tombstone] of this.tombstones) {
      if (tombstone.endedAt < cutoff) this.tombstones.delete(id)
    }
    const excess = this.tombstones.size - this.maxTombstones
    if (excess > 0) {
      const oldest = Array.from(this.tombstones.values()).sort((a, b) => a.endedAt - b.endedAt).slice(0, excess)
      oldest.forEach((tombstone) => this.tombstones.delete(tombstone.sessionId))
    }
  }

  private async writeState() {
    this.prune()
    await this.write(this.file, JSON.stringify(this.persistedState()))
  }

  /** Write-ahead: resolves once the state is on disk. */
  private persistNow(): Promise<void> {
    const next = this.writeChain.then(() => this.writeState())
    this.writeChain = next.catch((error) => { console.error('Manual hold state write failed', error) })
    return next
  }

  /** Write-behind for closures: never awaited by stop or expiry, coalesced under load. */
  private persistSoon() {
    if (this.writePending) return
    this.writePending = true
    this.writeChain = this.writeChain
      .then(() => { this.writePending = false; return this.writeState() })
      .catch((error) => { this.writePending = false; console.error('Manual hold state write failed', error) })
  }

  /** For tests and shutdown: resolves after every queued write has finished. */
  async flush() {
    await this.writeChain
  }

  // ---------------------------------------------------------------- lifecycle

  async recover() {
    let state: PersistedState | null = null
    const text = await this.read(this.file)
    if (text != null) {
      const parsed = JSON.parse(text)
      if (parsed && parsed.version === 2) state = parsed
      else if (parsed && typeof parsed === 'object') {
        // Version 1 kept { active, records }. Every recorded session is terminal now.
        state = {
          version: 2,
          active: parsed.active ? { sessionId: parsed.active.sessionId, ownerId: parsed.active.ownerId,
            route: { relayAddress: parsed.active.relayAddress, address: parsed.active.address, kind: 'pot' }, startedAt: parsed.active.startedAt } : null,
          tombstones: (Array.isArray(parsed.records) ? parsed.records : []).map((record: any) => ({
            sessionId: record.sessionId, ownerId: record.ownerId, status: 'closed', reason: 'released',
            endedAt: Number(record.deadline) || this.now(), route: null, openedForMs: null,
          })),
        }
      }
    }
    for (const tombstone of state?.tombstones ?? []) {
      if (tombstone && typeof tombstone.sessionId === 'string') this.tombstones.set(tombstone.sessionId, tombstone)
    }
    if (state?.active) {
      // A previous process may have died with this valve open. Close it before anything else.
      const session: HoldSession = {
        ...state.active, sequence: Number.MAX_SAFE_INTEGER, status: 'open', startedMono: this.mono(), openedMono: this.mono(),
        deadlineMono: this.mono(), renewals: 0, ended: null,
      }
      this.active = session
      await this.endSession(session, 'recovered_after_restart')
      if (this.faultSession) return
    }
    this.ready = true
    await this.persistNow().catch(() => undefined)
  }

  /** Ends any active session (controller stop, shutdown, state change). Resolves after the close attempt. */
  async stopAll(reason: EndReason = 'controller_stop') {
    const session = this.active
    if (!session) return
    await this.endSession(session, reason)
    // A session stopped while acquiring or opening finishes its own start flow first.
    if (session.settled) await session.settled
    if (session.status === 'open' || session.status === 'opening') await this.closeOpened(session, session.ended ?? reason)
  }

  /** Called only after an operator independently confirms every output is closed. */
  reconcileFault() {
    if (this.active || (this.faultSession && !this.faultResolved)) return false
    this.faultSession = null
    this.faultResolved = false
    this.ready = true
    return true
  }

  isReady() {
    return this.ready
  }

  snapshot() {
    const active = this.active
    const now = this.mono()
    return {
      ready: this.ready,
      active: active
        ? {
            sessionId: active.sessionId,
            ownerId: active.ownerId,
            route: active.route,
            status: active.status,
            remainingMs: Math.max(0, active.deadlineMono - now),
            openedForMs: active.openedMono == null ? null : now - active.openedMono,
          }
        : null,
      fault: this.faultSession ? { sessionId: this.faultSession.sessionId, route: this.faultSession.route } : null,
      leaseMs: this.leaseMs,
      maxContinuousMs: this.maxContinuousMs,
    }
  }

  // ---------------------------------------------------------------- timers

  private armExpiry() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    const session = this.active
    if (!session) return
    let delay = session.deadlineMono - this.mono()
    if (this.maxContinuousMs != null && session.openedMono != null) {
      delay = Math.min(delay, session.openedMono + this.maxContinuousMs - this.mono())
    }
    this.expiryTimer = setTimeout(() => this.onTimer(session), Math.max(0, delay))
    this.expiryTimer.unref?.()
  }

  private onTimer(session: HoldSession) {
    if (this.active !== session || session.ended) return
    const now = this.mono()
    if (this.maxContinuousMs != null && session.openedMono != null && now - session.openedMono >= this.maxContinuousMs) {
      void this.endSession(session, 'continuous_limit').catch(() => undefined)
      return
    }
    if (now >= session.deadlineMono) {
      void this.endSession(session, 'expired').catch(() => undefined)
      return
    }
    // Woken early (a renewal moved the deadline); sleep again.
    this.armExpiry()
  }

  private scheduleCloseRetry(session: HoldSession) {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.retryFaultClose(session)
    }, this.closeRetryMs)
    this.retryTimer.unref?.()
  }

  private async retryFaultClose(session: HoldSession) {
    try {
      await this.callbacks.close(session)
    } catch {
      this.scheduleCloseRetry(session)
      return
    }
    // Closed at last. The output is released, but new holds stay disabled until an
    // operator confirms the outlet and reconciles (or the controller restarts).
    this.faultResolved = true
    this.callbacks.release(session, session.ended ?? 'released')
    if (this.active === session) this.active = null
    const tombstone = this.tombstones.get(session.sessionId)
    if (tombstone) tombstone.status = 'closed'
    this.persistSoon()
  }

  // ---------------------------------------------------------------- session ends

  private bury(session: HoldSession, reason: EndReason, status: 'closed' | 'fault') {
    this.tombstones.set(session.sessionId, {
      sessionId: session.sessionId,
      ownerId: session.ownerId,
      status,
      reason,
      endedAt: this.now(),
      route: session.route,
      openedForMs: session.openedMono == null ? null : this.mono() - session.openedMono,
    })
  }

  private async endSession(session: HoldSession, reason: EndReason) {
    if (session.ended) return
    session.ended = reason
    if (this.expiryTimer && this.active === session) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    if (session.status === 'acquiring' || session.status === 'opening') {
      // Not open yet. The start flow gives the output back (or closes the relay once
      // its open call returns), so a second start cannot acquire alongside it and a
      // close can never race ahead of the open it is meant to undo.
      this.bury(session, reason, 'closed')
      this.persistSoon()
      return
    }
    await this.closeOpened(session, reason)
  }

  private closeOpened(session: HoldSession, reason: EndReason): Promise<void> {
    if (!session.closing) session.closing = this.doClose(session, reason)
    return session.closing
  }

  private async doClose(session: HoldSession, reason: EndReason) {
    try {
      await this.callbacks.close(session)
    } catch (error) {
      session.status = 'fault'
      this.ready = false
      this.faultSession = session
      this.faultResolved = false
      this.bury(session, reason, 'fault')
      this.callbacks.onFault?.(session, error)
      this.scheduleCloseRetry(session)
      this.persistSoon()
      throw error
    }
    if (this.active === session) this.active = null
    this.callbacks.release(session, reason)
    this.bury(session, reason, 'closed')
    this.persistSoon()
  }

  // ---------------------------------------------------------------- requests

  private remainingFor(signal: HoldSignal) {
    const remaining = Number(signal.expiresAt) - this.now()
    if (!Number.isFinite(remaining) || remaining <= 0) return 0
    return Math.min(this.leaseMs, remaining)
  }

  private reply(signal: HoldSignal, extra: Partial<HoldReply> = {}): HoldReply {
    const active = this.active
    const mine = active?.sessionId === signal.sessionId && !active.ended ? active : null
    const tombstone = mine ? null : this.tombstones.get(signal.sessionId)
    const busy = Boolean(active && active.sessionId !== signal.sessionId && !active.ended)
    const now = this.mono()
    return {
      status: mine ? (mine.status === 'fault' ? 'fault' : mine.status) : tombstone?.status === 'fault' ? 'fault' : 'closed',
      sessionId: signal.sessionId,
      ready: this.ready,
      busy,
      endReason: tombstone?.reason,
      sequence: mine?.sequence,
      openedForMs: mine?.openedMono != null ? now - mine.openedMono : tombstone?.openedForMs ?? undefined,
      remainingMs: mine ? Math.max(0, mine.deadlineMono - now) : undefined,
      leaseMilliseconds: this.leaseMs,
      maxContinuousMilliseconds: this.maxContinuousMs,
      activeOwnerId: busy ? active!.ownerId : undefined,
      activeRoute: busy ? active!.route : undefined,
      controllerTime: this.now(),
      ...extra,
    }
  }

  private validate(signal: HoldSignal) {
    if (!signal || !sessionPattern.test(String(signal.sessionId || '')) || !signal.ownerId || !Number.isInteger(signal.sequence) || signal.sequence < 0) {
      throw new HoldError('Invalid hold identity', 'invalid')
    }
  }

  private sameRoute(a: HoldRoute, b: HoldRoute | undefined) {
    return Boolean(b) && a.relayAddress === b!.relayAddress && a.address === b!.address
  }

  async request(action: HoldAction, signal: HoldSignal): Promise<HoldReply> {
    this.validate(signal)
    if (action === 'status') return this.reply(signal)
    if (action === 'stop') return this.stop(signal)
    if (action === 'renew') return this.renew(signal)
    return this.start(signal)
  }

  private async stop(signal: HoldSignal): Promise<HoldReply> {
    const active = this.active
    if (active?.sessionId === signal.sessionId) {
      if (active.ownerId !== signal.ownerId) throw new HoldError('Hold owner mismatch', 'owner')
      await this.endSession(active, 'released')
      return this.reply(signal)
    }
    const tombstone = this.tombstones.get(signal.sessionId)
    if (tombstone) {
      if (tombstone.ownerId !== signal.ownerId) throw new HoldError('Hold owner mismatch', 'owner')
      return this.reply(signal)
    }
    // Stop overtook its start: remember it so the delayed start can never open the valve.
    this.tombstones.set(signal.sessionId, {
      sessionId: signal.sessionId, ownerId: signal.ownerId, status: 'closed', reason: 'stopped_before_start',
      endedAt: this.now(), route: signal.route ?? null, openedForMs: null,
    })
    this.persistSoon()
    return this.reply(signal)
  }

  private renew(signal: HoldSignal): HoldReply {
    const active = this.active
    if (!active || active.sessionId !== signal.sessionId || active.ended) {
      const tombstone = this.tombstones.get(signal.sessionId)
      if (tombstone && tombstone.ownerId !== signal.ownerId) throw new HoldError('Hold owner mismatch', 'owner')
      // A renewal never creates a session.
      return this.reply(signal)
    }
    if (active.ownerId !== signal.ownerId) throw new HoldError('Hold owner mismatch', 'owner')
    if (!this.sameRoute(active.route, signal.route)) throw new HoldError('Hold route changed', 'route')
    if (signal.sequence <= active.sequence) return this.reply(signal)
    const remaining = this.remainingFor(signal)
    if (remaining <= 0) return this.reply(signal, { late: true })
    active.sequence = signal.sequence
    active.renewals += 1
    const deadline = this.mono() + remaining
    // Never shorten: an earlier, faster signal may already have extended further.
    if (deadline > active.deadlineMono) {
      active.deadlineMono = deadline
      if (!this.expiryTimer) this.armExpiry()
    }
    return this.reply(signal)
  }

  private async start(signal: HoldSignal): Promise<HoldReply> {
    if (!this.ready) {
      throw new HoldError(this.faultSession ? 'Manual control unavailable: a valve close was not confirmed. Check the outlet; the controller is retrying.' : 'Manual control unavailable: controller recovery required', 'unavailable')
    }
    const tombstone = this.tombstones.get(signal.sessionId)
    if (tombstone) {
      if (tombstone.ownerId !== signal.ownerId) throw new HoldError('Hold owner mismatch', 'owner')
      return this.reply(signal)
    }
    let active = this.active
    if (active && active.ended && active.settled) {
      // A stopped session is still giving the output back; let it finish first.
      await active.settled
      active = this.active
    }
    if (active?.sessionId === signal.sessionId && !active.ended) {
      // A duplicate start is a renewal of the same session, never a second actuation.
      if (active.ownerId !== signal.ownerId) throw new HoldError('Hold owner mismatch', 'owner')
      if (!this.sameRoute(active.route, signal.route)) throw new HoldError('Hold route changed', 'route')
      return this.renew(signal)
    }
    if (active && !active.ended) {
      if (!signal.takeover) throw new HoldError('Another manual hold is active', 'busy')
      // An authorized takeover closes the other session before this one may open anything.
      try {
        await this.endSession(active, 'preempted')
      } catch (error) {
        throw new HoldError(`The other session's valve did not confirm closed: ${error instanceof Error ? error.message : String(error)}`, 'failed')
      }
      if (active.settled) await active.settled
      if (this.active && !this.active.ended) throw new HoldError('Another manual hold is active', 'busy')
    }
    const remaining = this.remainingFor(signal)
    if (remaining <= 0) throw new HoldError('Hold signal expired', 'late')
    if (!signal.route || !Number.isInteger(signal.route.relayAddress) || !Number.isInteger(signal.route.address)) {
      throw new HoldError('Invalid valve route', 'invalid')
    }

    const session: HoldSession = {
      sessionId: signal.sessionId,
      ownerId: signal.ownerId,
      route: { ...signal.route },
      sequence: signal.sequence,
      status: 'acquiring',
      startedAt: this.now(),
      startedMono: this.mono(),
      openedMono: null,
      deadlineMono: this.mono() + remaining,
      renewals: 0,
      ended: null,
    }
    let settle!: () => void
    session.settled = new Promise<void>((resolve) => { settle = resolve })
    this.active = session
    this.armExpiry()

    const giveBack = (reason: EndReason) => {
      if (this.active === session) this.active = null
      this.callbacks.release(session, reason)
      settle()
    }

    try {
      await this.callbacks.acquire(session)
      if (!session.ended) await this.persistNow()
    } catch (error) {
      if (!session.ended) {
        session.ended = 'start_failed'
        if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = null }
        this.bury(session, 'start_failed', 'closed')
        this.persistSoon()
      }
      giveBack('start_failed')
      throw error instanceof HoldError ? error : new HoldError(error instanceof Error ? error.message : String(error), 'failed')
    }

    // A stop or the lease may have ended the session while the output was being acquired.
    if (session.ended || this.mono() >= session.deadlineMono) {
      if (!session.ended) {
        session.ended = 'expired'
        this.bury(session, 'expired', 'closed')
        this.persistSoon()
      }
      giveBack(session.ended)
      return this.reply(signal)
    }

    session.status = 'opening'
    try {
      await this.callbacks.open(session)
    } catch (error) {
      // The relay write may have partly succeeded; close it the normal way.
      session.status = 'open'
      session.openedMono = this.mono()
      const reason = session.ended ?? 'start_failed'
      session.ended = reason
      settle()
      await this.closeOpened(session, reason).catch(() => undefined)
      throw new HoldError(`Valve did not open: ${error instanceof Error ? error.message : String(error)}`, 'failed')
    }
    session.status = 'open'
    session.openedMono = this.mono()
    settle()
    if (session.ended) {
      // Released or expired while the relay write was in flight: close it now.
      await this.closeOpened(session, session.ended).catch(() => undefined)
      return this.reply(signal)
    }
    this.armExpiry()
    return this.reply(signal)
  }
}

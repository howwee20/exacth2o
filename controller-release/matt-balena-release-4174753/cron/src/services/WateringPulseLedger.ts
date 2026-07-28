import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import path from 'path'

export interface ActiveAutomaticPulse {
  pairId: string
  relayAddress: number
  address: number
  startedAt: number
}

interface PersistedPulseLedger {
  version: 1 | 2
  pulses: Record<string, number[]>
  active?: ActiveAutomaticPulse | null
}

export interface PulseLedgerDecision {
  allowed: boolean
  pulseCount: number
  lastPulseAt: number | null
  retryAt: number | null
  reason?: 'minimum_retry' | 'rolling_limit'
}

/**
 * Durable, fail-closed accounting for automatic irrigation pulses.
 *
 * The Bull queue serializes state transitions, but its job payload is not a
 * reliable safety ledger and is cleared when the controller is stopped or
 * restarted. This service persists the timestamps that enforce the per-pot
 * rolling limit and minimum retry interval to the cron_config volume.
 */
export class WateringPulseLedger {
  private pulses = new Map<string, number[]>()
  private active: ActiveAutomaticPulse | null = null
  private initialized = false

  constructor(
    private readonly filePath: string,
    private readonly retentionMs: number = 24 * 60 * 60 * 1000,
  ) {}

  async init(now: number = Date.now()): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as PersistedPulseLedger
      if (![1, 2].includes(parsed?.version) || !parsed.pulses || typeof parsed.pulses !== 'object') {
        throw new Error('automatic pulse ledger has an unsupported format')
      }

      for (const [pairId, timestamps] of Object.entries(parsed.pulses)) {
        if (!Array.isArray(timestamps)) {
          throw new Error(`automatic pulse ledger entry is invalid: ${pairId}`)
        }
        const valid = timestamps
          .map(Number)
          .filter((value) => Number.isFinite(value) && value <= now + 1000 && now - value <= this.retentionMs)
          .sort((left, right) => left - right)
        if (valid.length > 0) this.pulses.set(pairId, valid)
      }

      if (parsed.version === 2 && parsed.active != null) {
        const active = parsed.active
        if (
          typeof active.pairId !== 'string' ||
          !active.pairId ||
          !Number.isInteger(active.relayAddress) ||
          active.relayAddress < 0 ||
          active.relayAddress > 0x7f ||
          !Number.isInteger(active.address) ||
          active.address < 1 ||
          !Number.isFinite(active.startedAt) ||
          active.startedAt > now + 1000
        ) {
          throw new Error('automatic pulse ledger active valve is invalid')
        }
        this.active = { ...active }
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }

    this.initialized = true
    await this.persist(now)
  }

  decision(
    pairId: string,
    now: number,
    windowMs: number,
    maxPulses: number,
    minRetryMs: number,
  ): PulseLedgerDecision {
    this.requireInitialized()
    const recent = this.recent(pairId, now, windowMs)
    const lastPulseAt = recent.length > 0 ? recent[recent.length - 1] : null

    if (lastPulseAt !== null && minRetryMs > 0 && now - lastPulseAt < minRetryMs) {
      return {
        allowed: false,
        pulseCount: recent.length,
        lastPulseAt,
        retryAt: lastPulseAt + minRetryMs,
        reason: 'minimum_retry',
      }
    }

    if (Number.isFinite(maxPulses) && maxPulses >= 0 && recent.length >= maxPulses) {
      return {
        allowed: false,
        pulseCount: recent.length,
        lastPulseAt,
        retryAt: recent[recent.length - maxPulses] + windowMs,
        reason: 'rolling_limit',
      }
    }

    return {
      allowed: true,
      pulseCount: recent.length,
      lastPulseAt,
      retryAt: null,
    }
  }

  async reserve(
    pairId: string,
    now: number,
    windowMs: number,
    maxPulses: number,
    minRetryMs: number,
  ): Promise<PulseLedgerDecision> {
    if (this.active) {
      throw new Error(`automatic valve closure is still pending: ${this.active.pairId}`)
    }
    const decision = this.decision(pairId, now, windowMs, maxPulses, minRetryMs)
    if (!decision.allowed) return decision

    const retained = this.timestamps(pairId).filter((value) => now - value <= this.retentionMs)
    retained.push(now)
    this.pulses.set(pairId, retained)
    await this.persist(now)
    return { ...decision, pulseCount: decision.pulseCount + 1, lastPulseAt: now }
  }

  activePulse(): ActiveAutomaticPulse | null {
    this.requireInitialized()
    return this.active ? { ...this.active } : null
  }

  async beginActive(
    pairId: string,
    relayAddress: number,
    address: number,
    startedAt: number = Date.now(),
  ): Promise<ActiveAutomaticPulse> {
    this.requireInitialized()
    if (this.active) {
      throw new Error(`automatic valve closure is still pending: ${this.active.pairId}`)
    }
    if (
      !pairId ||
      !Number.isInteger(relayAddress) ||
      relayAddress < 0 ||
      relayAddress > 0x7f ||
      !Number.isInteger(address) ||
      address < 1 ||
      !Number.isFinite(startedAt)
    ) {
      throw new Error('automatic active valve record is invalid')
    }

    this.active = { pairId, relayAddress, address, startedAt }
    await this.persist(startedAt)
    return { ...this.active }
  }

  async completeActive(pairId: string, now: number = Date.now()): Promise<void> {
    this.requireInitialized()
    if (!this.active) return
    if (this.active.pairId !== pairId) {
      throw new Error(`automatic active valve mismatch: ${this.active.pairId}`)
    }
    this.active = null
    await this.persist(now)
  }

  private recent(pairId: string, now: number, windowMs: number): number[] {
    return this.timestamps(pairId).filter((value) => value >= now - windowMs && value <= now + 1000)
  }

  private timestamps(pairId: string): number[] {
    return [...(this.pulses.get(pairId) || [])].sort((left, right) => left - right)
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('automatic pulse ledger is not initialized')
  }

  private async persist(now: number): Promise<void> {
    this.requireInitialized()
    const pulses: Record<string, number[]> = {}
    for (const [pairId, timestamps] of this.pulses.entries()) {
      const retained = timestamps.filter((value) => now - value <= this.retentionMs)
      if (retained.length > 0) pulses[pairId] = retained
    }

    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(
      temporaryPath,
      JSON.stringify({ version: 2, pulses, active: this.active }, null, 2),
      'utf8'
    )
    await rename(temporaryPath, this.filePath)
  }
}

import { readFile, rename, writeFile } from 'fs/promises'

export interface ManualPulseRequest {
  pulseId: string
  commandId: string
  relayAddress: number
  address: number
  durationMilliseconds: number
}

interface ManualPulseRecord extends ManualPulseRequest {
  status: 'opening' | 'open' | 'closed' | 'failed' | 'recovered_closed'
  startedAt: string
  closedAt?: string
  error?: string
}

interface ManualPulseState {
  active: ManualPulseRecord | null
  records: ManualPulseRecord[]
}

export interface ManualPulseResult {
  pulseId: string
  commandId: string
  status: ManualPulseRecord['status']
  duplicate: boolean
  startedAt: string
  closedAt?: string
}

type ValveOperation = (request: ManualPulseRequest) => Promise<void> | void

const emptyState = (): ManualPulseState => ({ active: null, records: [] })

export class ManualPulseManager {
  private state: ManualPulseState = emptyState()
  private timer: NodeJS.Timeout | null = null
  private loaded = false

  constructor(
    private readonly stateFile: string,
    private readonly openValve: ValveOperation,
    private readonly closeValve: ValveOperation,
    private readonly emergencyCloseAll: () => Promise<void> | void,
    private readonly maxDurationMilliseconds = 60_000,
    private readonly maxCommandValveMilliseconds = 120_000,
  ) {}

  hasActivePulse(): boolean {
    return this.state.active !== null
  }

  private result(record: ManualPulseRecord, duplicate: boolean): ManualPulseResult {
    return {
      pulseId: record.pulseId,
      commandId: record.commandId,
      status: record.status,
      duplicate,
      startedAt: record.startedAt,
      closedAt: record.closedAt,
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as ManualPulseState
      this.state = {
        active: parsed?.active ?? null,
        records: Array.isArray(parsed?.records) ? parsed.records.slice(-200) : [],
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      this.state = emptyState()
    }
  }

  private async persist(): Promise<void> {
    const tempFile = `${this.stateFile}.tmp`
    await writeFile(tempFile, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    await rename(tempFile, this.stateFile)
  }

  async recover(): Promise<void> {
    await this.load()
    if (!this.state.active) return

    const active = this.state.active
    try {
      await this.closeWithFallback(active)
      active.status = 'recovered_closed'
    } catch (error: any) {
      active.status = 'failed'
      active.error = `restart recovery close failed: ${error?.message || error}`
      throw error
    } finally {
      active.closedAt = new Date().toISOString()
      this.state.records.push(active)
      this.state.records = this.state.records.slice(-200)
      this.state.active = null
      await this.persist()
    }
  }

  async pulse(request: ManualPulseRequest): Promise<ManualPulseResult> {
    await this.load()
    const duration = Number(request.durationMilliseconds)
    if (!request.pulseId || !request.commandId) throw new Error('pulseId and commandId are required')
    if (!Number.isInteger(duration) || duration < 1 || duration > this.maxDurationMilliseconds) {
      throw new Error(`durationMilliseconds must be between 1 and ${this.maxDurationMilliseconds}`)
    }

    const prior = this.state.records.find((record) => record.pulseId === request.pulseId)
    if (prior) return this.result(prior, true)
    if (this.state.active?.pulseId === request.pulseId) return this.result(this.state.active, true)
    if (this.state.active) throw new Error(`manual pulse already active: ${this.state.active.pulseId}`)

    const commandTotal = this.state.records
      .filter((record) => record.commandId === request.commandId)
      .reduce((sum, record) => sum + Number(record.durationMilliseconds || 0), 0)
    if (commandTotal + duration > this.maxCommandValveMilliseconds) {
      throw new Error(`manual pulse command exceeds ${this.maxCommandValveMilliseconds} aggregate valve-milliseconds`)
    }

    const active: ManualPulseRecord = {
      ...request,
      durationMilliseconds: duration,
      status: 'opening',
      startedAt: new Date().toISOString(),
    }
    this.state.active = active
    await this.persist()

    try {
      await this.openValve(active)
      active.status = 'open'
      await this.persist()
      this.timer = setTimeout(() => {
        void this.closeActive().catch((error) => {
          console.error('Manual pulse close failed after fallback', error)
        })
      }, duration)
      this.timer.unref?.()
      return this.result(active, false)
    } catch (error: any) {
      active.status = 'failed'
      active.error = error?.message || String(error)
      active.closedAt = new Date().toISOString()
      this.state.records.push(active)
      this.state.active = null
      await this.persist()
      throw error
    }
  }

  async closeActive(): Promise<ManualPulseResult | null> {
    await this.load()
    if (!this.state.active) return null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null

    const active = this.state.active
    try {
      await this.closeWithFallback(active)
      active.status = 'closed'
    } catch (error: any) {
      active.status = 'failed'
      active.error = error?.message || String(error)
      throw error
    } finally {
      active.closedAt = new Date().toISOString()
      this.state.records.push(active)
      this.state.records = this.state.records.slice(-200)
      this.state.active = null
      await this.persist()
    }
    return this.result(active, false)
  }

  private async closeWithFallback(request: ManualPulseRequest): Promise<void> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.closeValve(request)
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    try {
      await this.emergencyCloseAll()
      return
    } catch (error) {
      lastError = error
    }
    throw lastError instanceof Error ? lastError : new Error('manual pulse close failed')
  }
}

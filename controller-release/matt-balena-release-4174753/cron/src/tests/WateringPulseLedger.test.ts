import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'

import { WateringPulseLedger } from '../services/WateringPulseLedger'

describe('WateringPulseLedger', () => {
  let directory: string
  let ledgerPath: string

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'automatic-pulse-ledger-'))
    ledgerPath = path.join(directory, 'automatic-pulses.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('enforces a durable rolling two-pulse limit across restarts', async () => {
    const hour = 60 * 60 * 1000
    const halfHour = 30 * 60 * 1000
    const start = Date.UTC(2026, 6, 16, 12)
    const first = new WateringPulseLedger(ledgerPath)
    await first.init(start)

    expect((await first.reserve('712-1625', start, hour, 2, halfHour)).allowed).toBe(true)
    expect((await first.reserve('712-1625', start + halfHour, hour, 2, halfHour)).allowed).toBe(true)

    const restarted = new WateringPulseLedger(ledgerPath)
    await restarted.init(start + halfHour + 1000)
    const blocked = restarted.decision('712-1625', start + halfHour + 1000, hour, 2, halfHour)
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('minimum_retry')
    expect(blocked.pulseCount).toBe(2)

    const rollingBlocked = restarted.decision('712-1625', start + hour - 1, hour, 2, 0)
    expect(rollingBlocked.allowed).toBe(false)
    expect(rollingBlocked.reason).toBe('rolling_limit')
  })

  it('allows frequent measurements while keeping the same pot ineligible for 30 minutes', async () => {
    const hour = 60 * 60 * 1000
    const halfHour = 30 * 60 * 1000
    const start = Date.UTC(2026, 6, 16, 12)
    const ledger = new WateringPulseLedger(ledgerPath)
    await ledger.init(start)
    await ledger.reserve('712-1625', start, hour, 2, halfHour)

    expect(ledger.decision('712-1625', start + 14 * 60 * 1000, hour, 2, halfHour).allowed).toBe(false)
    expect(ledger.decision('712-1625', start + halfHour, hour, 2, halfHour).allowed).toBe(true)
  })

  it('fails closed when a persisted ledger is malformed', async () => {
    await writeFile(ledgerPath, '{not-json', 'utf8')
    const ledger = new WateringPulseLedger(ledgerPath)
    await expect(ledger.init()).rejects.toThrow()
    await expect(ledger.reserve('712-1625', Date.now(), 60_000, 2, 30_000)).rejects.toThrow(
      'automatic pulse ledger is not initialized'
    )
  })

  it('persists only timestamp data needed for safety accounting', async () => {
    const start = Date.UTC(2026, 6, 16, 12)
    const ledger = new WateringPulseLedger(ledgerPath)
    await ledger.init(start)
    await ledger.reserve('712-1625', start, 60 * 60 * 1000, 2, 30 * 60 * 1000)

    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8'))
    expect(persisted).toEqual({
      version: 2,
      pulses: { '712-1625': [start] },
      active: null,
    })
  })

  it('persists an active automatic valve until closure is confirmed', async () => {
    const start = Date.UTC(2026, 6, 16, 12)
    const first = new WateringPulseLedger(ledgerPath)
    await first.init(start)
    await first.beginActive('712-1625', 0x20, 3, start)

    const restarted = new WateringPulseLedger(ledgerPath)
    await restarted.init(start + 1000)
    expect(restarted.activePulse()).toEqual({
      pairId: '712-1625',
      relayAddress: 0x20,
      address: 3,
      startedAt: start,
    })
    await expect(
      restarted.reserve('713-1626', start + 1000, 60_000, 2, 0)
    ).rejects.toThrow('closure is still pending')

    await restarted.completeActive('712-1625', start + 2000)
    expect(restarted.activePulse()).toBeNull()
  })

  it('migrates a version-one timestamp ledger without losing pulse history', async () => {
    const start = Date.UTC(2026, 6, 16, 12)
    await writeFile(
      ledgerPath,
      JSON.stringify({ version: 1, pulses: { '712-1625': [start] } }),
      'utf8',
    )

    const ledger = new WateringPulseLedger(ledgerPath)
    await ledger.init(start + 1000)
    expect(ledger.decision('712-1625', start + 1000, 60_000, 2, 0).pulseCount).toBe(1)
    expect(JSON.parse(await readFile(ledgerPath, 'utf8')).version).toBe(2)
  })
})

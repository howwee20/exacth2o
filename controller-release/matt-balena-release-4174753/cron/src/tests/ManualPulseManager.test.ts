import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ManualPulseManager, ManualPulseRequest } from '../services/ManualPulseManager'

const request: ManualPulseRequest = {
  pulseId: 'command-1:0x20:3',
  commandId: 'command-1',
  relayAddress: 0x20,
  address: 3,
  durationMilliseconds: 20,
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'exacth2o-pulse-'))
  const stateFile = path.join(directory, 'manual-pulses.json')
  const calls: string[] = []
  const manager = new ManualPulseManager(
    stateFile,
    () => { calls.push('OPEN') },
    () => { calls.push('CLOSE') },
    () => { calls.push('CLOSE_ALL') },
    100,
    120,
  )
  return { directory, stateFile, calls, manager }
}

describe('ManualPulseManager', () => {
  test('owns the close timer and deduplicates the same pulse id', async () => {
    const { directory, calls, manager } = await fixture()
    try {
      const first = await manager.pulse(request)
      const duplicateWhileOpen = await manager.pulse(request)
      expect(first.duplicate).toBe(false)
      expect(duplicateWhileOpen.duplicate).toBe(true)
      expect(calls).toEqual(['OPEN'])
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(calls).toEqual(['OPEN', 'CLOSE'])
      const duplicateAfterClose = await manager.pulse(request)
      expect(duplicateAfterClose.duplicate).toBe(true)
      expect(calls).toEqual(['OPEN', 'CLOSE'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('closes a persisted active pulse before accepting work after restart', async () => {
    const { directory, stateFile, calls, manager } = await fixture()
    try {
      await writeFile(stateFile, JSON.stringify({
        active: { ...request, status: 'open', startedAt: new Date().toISOString() },
        records: [],
      }))
      await manager.recover()
      expect(calls).toEqual(['CLOSE'])
      const stored = JSON.parse(await readFile(stateFile, 'utf8'))
      expect(stored.active).toBeNull()
      expect(stored.records[0].status).toBe('recovered_closed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects conflicts, duration overflow, and aggregate command overflow', async () => {
    const { directory, manager } = await fixture()
    try {
      await expect(manager.pulse({ ...request, durationMilliseconds: 101 })).rejects.toThrow('between 1 and 100')
      await manager.pulse({ ...request, durationMilliseconds: 70 })
      await expect(manager.pulse({
        ...request,
        pulseId: 'command-2:0x20:4',
        commandId: 'command-2',
        address: 4,
      })).rejects.toThrow('already active')
      await manager.closeActive()
      await expect(manager.pulse({
        ...request,
        pulseId: 'command-1:0x20:4',
        address: 4,
        durationMilliseconds: 60,
      })).rejects.toThrow('aggregate')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('uses emergency close-all after repeated close failures', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'exacth2o-pulse-'))
    const calls: string[] = []
    const manager = new ManualPulseManager(
      path.join(directory, 'state.json'),
      () => { calls.push('OPEN') },
      () => { calls.push('CLOSE'); throw new Error('i2c close failed') },
      () => { calls.push('CLOSE_ALL') },
      100,
      120,
    )
    try {
      await manager.pulse(request)
      await manager.closeActive()
      expect(calls).toEqual(['OPEN', 'CLOSE', 'CLOSE', 'CLOSE', 'CLOSE_ALL'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

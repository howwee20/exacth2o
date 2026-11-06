// Review reproduction (scratch only): a state-file write failure after the relay opened.
let writes = 0
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises')
  return {
    ...actual,
    readFile: jest.fn(async () => { const e: any = new Error('nope'); e.code = 'ENOENT'; throw e }),
    rename: jest.fn(async () => undefined),
    writeFile: jest.fn(async () => { writes += 1; if (writes >= 2) { const e: any = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e } }),
  }
})
import { ManualPulseManager } from '../services/ManualPulseManager'

it('state write failure after opening cannot prevent timed closure', async () => {
  jest.useFakeTimers()
  const relay: string[] = []
  const manager = new ManualPulseManager('/tmp/x.json',
    (r) => { relay.push(`OPEN:${r.address}`) },
    (r) => { relay.push(`CLOSE:${r.address}`) },
    () => { relay.push('CLOSE_ALL') })
  await expect(manager.pulse({ pulseId: 'p1', commandId: 'c1', relayAddress: 32, address: 5, durationMilliseconds: 3000 })).resolves.toMatchObject({status: 'open'})
  await jest.advanceTimersByTimeAsync(120_000)
  await Promise.resolve()
  console.log('relay', relay, 'hasActive', manager.hasActivePulse(), 'remaining', manager.remainingMilliseconds())
  expect(relay).toEqual(['OPEN:5', 'CLOSE:5'])
  expect(manager.hasActivePulse()).toBe(false)
  jest.useRealTimers()
})

jest.mock('i2c-bus', () => ({
  openSync: jest.fn(),
}))

import StateMachine from '../StateMachine'
import { ManualHoldManager } from '../services/ManualHoldManager'
import { ValveArbiter } from '../services/ValveArbiter'
import { MachineState } from '../types'

// One controller with three valve boards (0x20, 0x24, 0x26) and 48 channels each,
// an automatic pulse in progress, and a hold manager wired to the real StateMachine
// callbacks. Relay writes are recorded instead of reaching I2C.
function controller(options: { inventory?: Array<{ relayAddress: string; address: string }>; state?: MachineState } = {}) {
  let monoNow = 5_000_000
  const machine = Object.create(StateMachine.prototype) as any
  const relay: string[] = []
  machine.state = options.state ?? MachineState.RUNNING
  machine.openValvePairId = null
  machine.lastValveClosedAt = null
  machine.valveInventory = null
  machine.arbiter = new ValveArbiter(() => monoNow, 60_000, 120_000)
  machine.apiService = {
    postData: jest.fn().mockResolvedValue(undefined),
    fetchData: jest.fn(async (path: string) => {
      if (path === '/v1/valves') {
        return options.inventory ?? [0x20, 0x24, 0x26].flatMap((board) => Array.from({ length: 48 }, (_, index) => ({ relayAddress: `0x${board.toString(16)}`, address: String(index + 1) })))
      }
      return null
    }),
  }
  machine.valveService = {
    getBoardConfigs: () => [{ address: 0x20 }, { address: 0x24 }, { address: 0x26 }],
    calculateColumnAndPin: (address: number) => ({ column: Math.floor((address - 1) / 8), pin: (address - 1) % 8 }),
    operateValve: jest.fn((board: number, column: number, pin: number, state: string) => relay.push(`${state}:${board}:${column * 8 + pin + 1}`)),
    closeAllValves: jest.fn(() => relay.push('CLOSE_ALL')),
  }
  const automaticPairing = { sensorId: 712, valveId: 1625, valveOpened: true, nextTransitionTime: Date.now() + 4_000, Valve: { relayAddress: '0x20', address: '3' } } as any
  machine.pairingService = {
    getPairing: (sensorId: string, valveId: string) => (sensorId === '712' && valveId === '1625' ? automaticPairing : undefined),
    getAllPairings: () => [automaticPairing],
  }
  let activeAutomatic: any = null
  machine.wateringPulseLedger = {
    activePulse: () => activeAutomatic,
    completeActive: jest.fn(async () => { activeAutomatic = null }),
  }
  let activeTimed: any = null
  machine.manualPulseManager = {
    priorResult: () => null,
    hasActivePulse: () => Boolean(activeTimed),
    remainingMilliseconds: () => (activeTimed ? 2_000 : null),
    pulse: jest.fn(async (request: any) => { activeTimed = request; relay.push(`OPEN:${request.relayAddress}:${request.address}`); return { status: 'open' } }),
    closeActive: jest.fn(async (reason?: string) => { relay.push(`CLOSE:${activeTimed?.relayAddress}:${activeTimed?.address}${reason ? `:${reason}` : ''}`); activeTimed = null; return {} }),
  }
  const storage = new Map<string, string>()
  machine.manualHoldManager = new ManualHoldManager('holds.json', {
    acquire: (session) => machine.acquireForHold(session),
    open: (session) => machine.openManualHold(session),
    close: (session) => machine.closeManualHold(session),
    release: (session, reason) => machine.releaseManualHold(session, reason),
    onFault: () => machine.arbiter.recordFault('close unconfirmed', 'close_failed'),
  }, {
    write: async (name, body) => { storage.set(name, body) },
    read: async (name) => storage.get(name) ?? null,
  })
  const startAutomatic = () => {
    activeAutomatic = { pairId: '712-1625', relayAddress: 0x20, address: 3, startedAt: Date.now() }
    machine.openValvePairId = '712-1625'
    automaticPairing.valveOpened = true
    relay.push('OPEN:32:3')
  }
  const hold = (action: string, overrides: Record<string, unknown> = {}) => machine.holdManualValve(action, {
    sessionId: '11111111-2222-4333-8444-555555555555', ownerId: 'jake', sequence: action === 'start' ? 0 : 1,
    expiresAt: Date.now() + 2_000, relayAddress: 0x20, address: 26, destinationKind: 'solenoid', ...overrides,
  })
  return { machine, relay, automaticPairing, startAutomatic, hold, advanceMono: (ms: number) => { monoNow += ms } }
}

describe('manual troubleshooting takes coordinated ownership of the shared output', () => {
  const previous = process.env.EXACTH2O_MANUAL_HOLD_ENABLED
  beforeEach(() => { process.env.EXACTH2O_MANUAL_HOLD_ENABLED = '1' })
  afterAll(() => { process.env.EXACTH2O_MANUAL_HOLD_ENABLED = previous })

  it('closes an active automatic pulse through its normal path before opening the held output', async () => {
    const { machine, relay, automaticPairing, startAutomatic, hold } = controller()
    await machine.manualHoldManager.recover()
    startAutomatic()
    const reply = await hold('start')
    expect(reply.status).toBe('open')
    expect(relay).toEqual(['OPEN:32:3', 'CLOSE:32:3', 'OPEN:32:26'])
    expect(machine.wateringPulseLedger.completeActive).toHaveBeenCalledWith('712-1625')
    expect(automaticPairing.valveOpened).toBe(false)
    expect(machine.openValvePairId).toBe('hold:11111111-2222-4333-8444-555555555555')
    expect(reply.automaticSuspended).toBe(true)
    await hold('stop', { sequence: 2 })
    expect(machine.openValvePairId).toBeNull()
  })

  it('suspends automatic starts during manual control and for the settling window after release', async () => {
    const { machine, hold, advanceMono } = controller()
    await machine.manualHoldManager.recover()
    await hold('start')
    expect(machine.arbiter.automaticOpen()).toMatchObject({ allowed: false, reason: 'manual troubleshooting in progress' })
    await hold('stop', { sequence: 2 })
    expect(machine.arbiter.automaticOpen()).toMatchObject({ allowed: false, reason: 'settling after manual watering' })
    advanceMono(61_000)
    expect(machine.arbiter.automaticOpen()).toEqual({ allowed: true })
  })

  it('refuses queued autocalibration pulses while an operator holds an output, and right after', async () => {
    const { machine, hold, advanceMono } = controller()
    await machine.manualHoldManager.recover()
    await hold('start')
    await expect(machine.pulseManualValve({ relayAddress: 0x20, address: 5, durationMilliseconds: 3_000, pulseId: 'p1', commandId: 'c1' })).rejects.toThrow('timed pulse refused: manual troubleshooting in progress')
    await hold('stop', { sequence: 2 })
    await expect(machine.pulseManualValve({ relayAddress: 0x20, address: 5, durationMilliseconds: 3_000, pulseId: 'p2', commandId: 'c2' })).rejects.toThrow('readings are still settling')
    advanceMono(121_000)
    await expect(machine.pulseManualValve({ relayAddress: 0x20, address: 5, durationMilliseconds: 3_000, pulseId: 'p3', commandId: 'c3' })).resolves.toMatchObject({ status: 'open' })
  })

  it('interrupts a timed autocalibration pulse in progress and records why', async () => {
    const { machine, relay, hold } = controller()
    await machine.manualHoldManager.recover()
    await machine.pulseManualValve({ relayAddress: 0x20, address: 5, durationMilliseconds: 3_000, pulseId: 'p1', commandId: 'c1' })
    expect(machine.openValvePairId).toBe('manual:p1')
    await hold('start')
    expect(relay).toEqual(['OPEN:32:5', 'CLOSE:32:5:preempted_by_manual_hold', 'OPEN:32:26'])
  })

  it('works with automatic watering disabled, the controller STOPPED and no sensor pairing on the output', async () => {
    const { machine, relay, hold } = controller({ state: MachineState.STOPPED })
    await machine.manualHoldManager.recover()
    const reply = await hold('start', { relayAddress: 0x26, address: 48 })
    expect(reply.status).toBe('open')
    expect(relay).toEqual(['OPEN:38:48'])
  })

  it('rejects outputs that are not in the controller inventory, and boards that are not configured', async () => {
    const { machine, relay, hold } = controller({ inventory: [{ relayAddress: '0x20', address: '26' }] })
    await machine.manualHoldManager.recover()
    await expect(hold('start', { relayAddress: 0x20, address: 27 })).rejects.toThrow('not in the controller valve inventory')
    await expect(hold('start', { sessionId: '11111111-2222-4333-8444-555555555556', relayAddress: 0x30, address: 1 })).rejects.toThrow('board unavailable')
    expect(relay).toEqual([])
    expect(machine.arbiter.manualControl).toBeNull()
  })

  it('records a hand-watered paired pot so automatic irrigation honors its normal settling rules', async () => {
    const { machine, automaticPairing, hold } = controller()
    await machine.manualHoldManager.recover()
    automaticPairing.valveOpened = false
    await hold('start', { relayAddress: 0x20, address: 3 })
    expect(automaticPairing.lastValveOpenedAt).toEqual(expect.any(Number))
    expect(automaticPairing.wateringWindowPulseCount).toBe(1)
  })

  it('never starts a hold in the middle of a topology rewrite, and a rewrite waits for an active hold', async () => {
    const { machine, relay, hold } = controller()
    await machine.manualHoldManager.recover()
    expect(machine.beginConfigRewrite('remap-1', 30_000)).toEqual({ allowed: true })
    await expect(hold('start')).rejects.toThrow('topology change is being applied')
    machine.endConfigRewrite('remap-1')
    await hold('start', { sessionId: '11111111-2222-4333-8444-555555555557' })
    expect(machine.beginConfigRewrite('remap-2', 30_000)).toMatchObject({ allowed: false })
    expect(relay).toEqual(['OPEN:32:26'])
  })

  it('a watchdog trip refuses every new opening until an operator reconciles', async () => {
    const { machine, relay, hold } = controller()
    await machine.manualHoldManager.recover()
    machine.recordWatchdogTrip('hold lease overrun while cron was unresponsive')
    await expect(hold('start')).rejects.toThrow('valve watchdog')
    expect(machine.arbiter.automaticOpen()).toMatchObject({ allowed: false })
    const status = await hold('status')
    expect(status.ready).toBe(false)
    expect(status.fault).toContain('valve watchdog')
    await machine.reconcileValveFault('Checked every outlet at the bench')
    expect(relay).toEqual(['CLOSE_ALL'])
    expect(machine.arbiter.fault).toBeNull()
    await expect(hold('start', { sessionId: '11111111-2222-4333-8444-555555555558' })).resolves.toMatchObject({ status: 'open' })
  })

  it('an automatic valve that will not close blocks the takeover and keeps watering blocked', async () => {
    const { machine, relay, startAutomatic, hold } = controller()
    await machine.manualHoldManager.recover()
    startAutomatic()
    machine.closeAutomaticPulseWithFallback = jest.fn().mockRejectedValue(new Error('relay close failed'))
    await expect(hold('start')).rejects.toThrow('did not confirm closed')
    expect(relay).toEqual(['OPEN:32:3'])
    expect(machine.openValvePairId).toBe('712-1625')
    expect(machine.arbiter.fault?.source).toBe('close_failed')
    expect(machine.arbiter.manualControl).toBeNull()
  })

  it('stop and status still answer when hold-to-water is not commissioned, but start is refused', async () => {
    const { machine, hold } = controller()
    await machine.manualHoldManager.recover()
    process.env.EXACTH2O_MANUAL_HOLD_ENABLED = '0'
    await expect(hold('start')).rejects.toThrow('not commissioned')
    await expect(hold('stop')).resolves.toMatchObject({ status: 'closed', available: false })
    await expect(hold('status')).resolves.toMatchObject({ status: 'closed', available: false })
  })

  it('reports ownership and the remaining lease for the independent watchdog', async () => {
    const { machine, hold } = controller()
    await machine.manualHoldManager.recover()
    await hold('start')
    const status = machine.getArbiterStatus()
    expect(status.owner).toMatchObject({ kind: 'hold' })
    expect(status.owner.deadlineInMs).toBeGreaterThan(0)
    expect(status.owner.deadlineInMs).toBeLessThanOrEqual(2_500)
  })
})

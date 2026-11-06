// Review reproduction (scratch copy only, not part of the repository).
// Interleaves handleValveOpenState (automatic watering) with a manual hold start
// at the await points between the arbitration check and the relay OPEN.
jest.mock('i2c-bus', () => ({ openSync: jest.fn() }))
jest.mock('../services/WateringSafety', () => {
  const actual = jest.requireActual('../services/WateringSafety')
  return { ...actual, getValveOpenSafetyDecision: () => ({ allowed: true }), recordValveOpen: () => undefined }
})

import StateMachine from '../StateMachine'
import { ManualHoldManager } from '../services/ManualHoldManager'
import { ValveArbiter } from '../services/ValveArbiter'
import { MachineState } from '../types'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

function controller(opts: { reserveGate?: Promise<void>; logGate?: () => Promise<void> } = {}) {
  const machine = Object.create(StateMachine.prototype) as any
  const relay: string[] = []
  machine.state = MachineState.RUNNING
  machine.openValvePairId = null
  machine.lastValveClosedAt = null
  machine.valveInventory = null
  machine.arbiter = new ValveArbiter(() => 5_000_000, 60_000, 120_000)
  const automaticPairing: any = {
    sensorId: 712, valveId: 1625, valveOpened: false, nextTransitionTime: Date.now(),
    Valve: { relayAddress: '0x20', address: '3' }, timingRules: { valveOpenTime: 3000, intervalTime: 60000 },
  }
  machine.apiService = {
    postData: jest.fn(async (_path: string, body: any) => {
      if (opts.logGate && /Valve open phase/.test(body?.message ?? '')) await opts.logGate()
    }),
    fetchData: jest.fn(async (path: string) => {
      if (path === '/v1/valves') return [0x20].flatMap((b) => Array.from({ length: 48 }, (_, i) => ({ relayAddress: `0x${b.toString(16)}`, address: String(i + 1) })))
      return { WTCPercentLimit: 30, ValveOpenTime: 3000, MeasurementInterval: 60000, Calibration: null }
    }),
  }
  machine.valveService = {
    getBoardConfigs: () => [{ address: 0x20 }],
    calculateColumnAndPin: (address: number) => ({ column: Math.floor((address - 1) / 8), pin: (address - 1) % 8 }),
    operateValve: jest.fn((board: number, column: number, pin: number, state: string) => relay.push(`${state}:${board}:${column * 8 + pin + 1}`)),
    closeAllValves: jest.fn(() => relay.push('CLOSE_ALL')),
  }
  machine.pairingService = {
    getPairing: (s: string, v: string) => (s === '712' && v === '1625' ? automaticPairing : undefined),
    getAllPairings: () => [automaticPairing],
  }
  machine.eventQueueService = { registerValveWaiter: jest.fn(async () => undefined), hasEarlierValveWaiter: jest.fn(async () => false), wakeNextValveWaiter: jest.fn(async () => undefined) }
  let active: any = null
  machine.wateringPulseLedger = {
    reserve: jest.fn(async () => { if (opts.reserveGate) await opts.reserveGate; return { allowed: true } }),
    beginActive: jest.fn(async (pairId: string, relayAddress: number, address: number, startedAt: number) => { active = { pairId, relayAddress, address, startedAt }; return active }),
    activePulse: () => active,
    completeActive: jest.fn(async () => { active = null }),
  }
  machine.manualPulseManager = { priorResult: () => null, hasActivePulse: () => false, remainingMilliseconds: () => null, closeActive: jest.fn(async () => ({})) }
  const storage = new Map<string, string>()
  machine.manualHoldManager = new ManualHoldManager('holds.json', {
    acquire: (s) => machine.acquireForHold(s), open: (s) => machine.openManualHold(s), close: (s) => machine.closeManualHold(s),
    release: (s, r) => machine.releaseManualHold(s, r), onFault: () => machine.arbiter.recordFault('x', 'close_failed'),
  }, { write: async (n, b) => { storage.set(n, b) }, read: async (n) => storage.get(n) ?? null })
  const hold = (action: string, seq: number) => machine.holdManualValve(action, {
    sessionId: '11111111-2222-4333-8444-555555555555', ownerId: 'jake', sequence: seq,
    expiresAt: Date.now() + 2_000, relayAddress: 0x20, address: 26, destinationKind: 'solenoid',
  })
  return { machine, relay, automaticPairing, hold }
}

const lastState = (relay: string[], channel: string) => relay.filter((e) => e.endsWith(channel)).pop()

describe('regression: automatic open vs manual hold interleavings', () => {
  beforeEach(() => { process.env.EXACTH2O_MANUAL_HOLD_ENABLED = '1' })
  afterEach(async () => { /* timers are unref'd */ })

  it('A: hold starts while automatic is inside ledger.reserve -> hold retains ownership and closes on release', async () => {
    const gate = deferred()
    const { machine, relay, hold } = controller({ reserveGate: gate.promise })
    await machine.manualHoldManager.recover()
    const auto = machine.handleValveOpenState(machine.pairingService.getPairing('712', '1625'), '712-1625')
    await new Promise((r) => setImmediate(r))
    expect(machine.openValvePairId).toBeNull() // automatic passed arbitration, waiting on ledger I/O
    const started = await hold('start', 0)
    expect(started.status).toBe('open')
    gate.resolve()
    expect(await auto).toBe('DELAY')
    expect(machine.openValvePairId).toBe('hold:11111111-2222-4333-8444-555555555555') // hold ownership overwritten
    const stopped = await hold('stop', 5)
    console.log('A relay log', relay, 'stop reply', stopped.status)
    expect(stopped.status).toBe('closed')            // operator is told "closed"
    expect(lastState(relay, ':32:26')).toBe('CLOSE:32:26') // ...but the hold relay was never closed
    // automatic close path closes only its own output
    await machine.handleValveCloseState(machine.pairingService.getPairing('712', '1625'), '712-1625')
    console.log('A after automatic close', relay)
    expect(lastState(relay, ':32:26')).toBe('CLOSE:32:26')
    await machine.manualHoldManager.flush()
  })

  it('B: hold starts while automatic awaits its "Valve open phase" log -> automatic relay closes when preempted', async () => {
    const logGate = deferred()
    const { machine, relay, hold, automaticPairing } = controller({ logGate: () => logGate.promise })
    await machine.manualHoldManager.recover()
    const auto = machine.handleValveOpenState(automaticPairing, '712-1625')
    for (let i = 0; i < 10 && machine.openValvePairId !== '712-1625'; i++) await new Promise((r) => setImmediate(r))
    expect(machine.openValvePairId).toBe('712-1625') // lock taken, relay not yet written
    const started = await hold('start', 0)           // preempts the not-yet-open automatic pulse
    expect(started.status).toBe('open')
    logGate.resolve()
    expect(await auto).toBe('VALVE_OPEN')            // automatic now writes OPEN anyway
    console.log('B relay log after both', relay, 'owner', machine.openValvePairId, 'valveOpened', automaticPairing.valveOpened)
    const closeResult = await machine.handleValveCloseState(automaticPairing, '712-1625')
    console.log('B automatic close result', closeResult, relay)
    await hold('stop', 5)
    console.log('B final relay', relay)
    expect(lastState(relay, ':32:3')).toBe('CLOSE:32:3') // automatic relay left open with no owner
    await machine.manualHoldManager.flush()
  })
})

describe('regression: automatic open vs timed pulse', () => {
  it('C: autocalibration/manual_water pulse accepted while automatic is inside ledger.reserve -> automatic request defers to the timed pulse', async () => {
    const gate = deferred()
    const { machine, relay } = controller({ reserveGate: gate.promise })
    let activeTimed: any = null
    machine.manualPulseManager = {
      priorResult: () => null, hasActivePulse: () => Boolean(activeTimed), remainingMilliseconds: () => 3000,
      pulse: jest.fn(async (r: any) => { activeTimed = r; relay.push(`OPEN:${r.relayAddress}:${r.address}`); return { status: 'open' } }),
    }
    const auto = machine.handleValveOpenState(machine.pairingService.getPairing('712', '1625'), '712-1625')
    await new Promise((r) => setImmediate(r))
    await machine.pulseManualValve({ relayAddress: 32, address: 40, durationMilliseconds: 3000, pulseId: 'p1', commandId: 'c1' })
    gate.resolve()
    await auto
    console.log('C relay', relay, 'owner', machine.openValvePairId)
    expect(relay).toEqual(['OPEN:32:40'])
  })
})

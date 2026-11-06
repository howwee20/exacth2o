jest.mock('i2c-bus', () => ({ openSync: jest.fn() }))

import StateMachine from '../StateMachine'
import { BullQueueService } from '../services/BullQueueService'
import { RulesEngineService } from '../services/RulesEngineService'
import { DEFAULT_TIMING } from '../config/constants'
import { MachineState, PairingState } from '../types'

function request(order = 1): PairingState {
  return {
    sensorId: order, valveId: order, state: 'DELAY', valveWaitOrder: order,
    WTCPercentLimit: 30, WTCPercentMeasured: 20, ValveOpenTime: 3000, MeasurementInterval: 600000,
    measurementValid: true, wateringMeasurementValid: true, lastMeasurementAt: Date.now(),
    lastValveOpenedAt: null, wateringWindowStartedAt: null, wateringWindowPulseCount: 0,
    previousWTCPercentMeasured: 20, previousMeasurementAt: null, valveOpened: false,
    nextTransitionTime: Date.now(),
    timingRules: { measurementTime: 1000, delayTime: 0, valveOpenTime: 3000, intervalTime: 600000, startDelayTime: 0 },
    Valve: { address: '1', relayAddress: '0x20' },
    Calibration: { polynomialCoefficientsCommaDelimited: '0,1' },
  } as PairingState
}

function job(order: number, state = 'DELAY') {
  return {
    data: { pairing: request(order), newState: state },
    isDelayed: jest.fn().mockResolvedValue(true),
    update: jest.fn().mockResolvedValue(undefined), promote: jest.fn().mockResolvedValue(undefined),
  }
}

function machine() {
  const m = Object.create(StateMachine.prototype) as any
  m.state = MachineState.RUNNING
  m.openValvePairId = null
  m.lastValveClosedAt = null
  m.arbiter = { automaticOpen: jest.fn(() => ({ allowed: true })) }
  m.apiService = { postData: jest.fn().mockResolvedValue(undefined) }
  m.eventQueueService = {
    wakeNextValveWaiter: jest.fn().mockResolvedValue(undefined),
    registerValveWaiter: jest.fn().mockResolvedValue(undefined),
    hasEarlierValveWaiter: jest.fn().mockResolvedValue(false),
    queueStateTransition: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined),
  }
  m.getLivePairing = jest.fn(async (p: PairingState) => p)
  m.wateringPulseLedger = {
    reserve: jest.fn().mockResolvedValue({ allowed: true }),
    beginActive: jest.fn().mockResolvedValue({}), activePulse: jest.fn(() => null),
    completeActive: jest.fn().mockResolvedValue(undefined),
  }
  m.operateAutomaticPulseValve = jest.fn()
  m.rulesEngineService = new RulesEngineService()
  return m
}

describe('FIFO valve requests in the transition queue', () => {
  it('assigns a Redis sequence once and retains it across retries', async () => {
    const s = Object.create(BullQueueService.prototype) as any
    s.queue = { client: { incr: jest.fn().mockResolvedValue(101) }, toKey: (k: string) => k }
    const p = request(); delete p.valveWaitOrder
    await s.registerValveWaiter(p)
    await s.registerValveWaiter(p)
    expect(p.valveWaitOrder).toBe(101)
    expect(s.queue.client.incr).toHaveBeenCalledTimes(1)
  })

  it('wakes only the oldest request, regardless of retry deadline order', async () => {
    const s = Object.create(BullQueueService.prototype) as any
    const b = job(1), c = job(2), unrelated = job(0, 'MEASURING')
    s.queue = { getJobs: async () => [c, unrelated, b] }
    expect(await s.hasEarlierValveWaiter(request(3))).toBe(true)
    await s.wakeNextValveWaiter()
    expect(b.update).toHaveBeenCalledWith(expect.objectContaining({ pairing: expect.objectContaining({ valveWaitOrder: 1, nextTransitionTime: expect.any(Number) }) }))
    expect(b.promote).toHaveBeenCalledTimes(1)
    expect(c.promote).not.toHaveBeenCalled()
    expect(unrelated.promote).not.toHaveBeenCalled()
    expect(b.update.mock.invocationCallOrder[0]).toBeLessThan(b.promote.mock.invocationCallOrder[0])
  })

  it('does not promote a later request when the head is already ready', async () => {
    const s = Object.create(BullQueueService.prototype) as any
    const b = job(1), c = job(2)
    b.isDelayed.mockResolvedValue(false)
    s.queue = { getJobs: async () => [b, c] }
    await s.wakeNextValveWaiter()
    expect(c.promote).not.toHaveBeenCalled()
    expect(await s.hasEarlierValveWaiter(request(2))).toBe(true)
  })

  it('retains the fallback job when notification fails', async () => {
    const s = Object.create(BullQueueService.prototype) as any
    const b = job(1)
    b.promote.mockRejectedValue(new Error('Redis unavailable'))
    s.queue = { getJobs: async () => [b] }
    await expect(s.wakeNextValveWaiter()).rejects.toThrow('Redis unavailable')
    expect(b.data.pairing.valveWaitOrder).toBe(1)
  })
})

describe('controller handoff', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1_000_000) })
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

  it('wakes at the recovery deadline, without adding a conflict-retry interval', async () => {
    const m = machine()
    m.lastValveClosedAt = Date.now()
    await m.wakeNextValveWaiter()
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMING.VALVE_RECOVERY_DELAY - 1)
    expect(m.eventQueueService.wakeNextValveWaiter).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(m.eventQueueService.wakeNextValveWaiter).toHaveBeenCalledTimes(1)
  })

  it('wakes immediately when recovery is already complete', async () => {
    const m = machine()
    m.lastValveClosedAt = Date.now() - DEFAULT_TIMING.VALVE_RECOVERY_DELAY
    await m.wakeNextValveWaiter()
    expect(m.eventQueueService.wakeNextValveWaiter).toHaveBeenCalledTimes(1)
  })

  it('retains ownership and never wakes a successor after failed closure', async () => {
    const m = machine(), p = request()
    p.valveOpened = true
    m.openValvePairId = '1-1'
    m.closeAutomaticPulseWithFallback = jest.fn().mockRejectedValue(new Error('close failed'))
    expect(await m.handleValveCloseState(p, '1-1')).toBe('VALVE_OPEN')
    await m.wakeNextValveWaiter()
    expect(m.openValvePairId).toBe('1-1')
    expect(m.eventQueueService.wakeNextValveWaiter).not.toHaveBeenCalled()
  })

  it('successful closure schedules the successor only after recovery', async () => {
    const m = machine(), p = request()
    p.valveOpened = true
    m.openValvePairId = '1-1'
    m.closeAutomaticPulseWithFallback = jest.fn().mockResolvedValue(undefined)
    await m.processStateTransition({ pairing: p, newState: 'VALVE_OPEN' })
    expect(m.closeAutomaticPulseWithFallback).toHaveBeenCalledTimes(1)
    expect(m.openValvePairId).toBeNull()
    expect(m.eventQueueService.wakeNextValveWaiter).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMING.VALVE_RECOVERY_DELAY)
    expect(m.eventQueueService.wakeNextValveWaiter).toHaveBeenCalledTimes(1)
  })

  it('honors manual-control settling before waking', async () => {
    const m = machine()
    m.arbiter.automaticOpen.mockReturnValue({ allowed: false, retryInMs: 60000 })
    await m.wakeNextValveWaiter()
    await jest.advanceTimersByTimeAsync(59999)
    expect(m.eventQueueService.wakeNextValveWaiter).not.toHaveBeenCalled()
    m.arbiter.automaticOpen.mockReturnValue({ allowed: true })
    await jest.advanceTimersByTimeAsync(1)
    expect(m.eventQueueService.wakeNextValveWaiter).toHaveBeenCalledTimes(1)
  })

  it('does not wake through a latched fault', async () => {
    const m = machine()
    m.arbiter.automaticOpen.mockReturnValue({ allowed: false, retryInMs: null })
    await m.wakeNextValveWaiter()
    expect(jest.getTimerCount()).toBe(0)
    expect(m.eventQueueService.wakeNextValveWaiter).not.toHaveBeenCalled()
  })

  it('cancels a pending wake before stop drains the worker', async () => {
    const m = machine()
    m.lastValveClosedAt = Date.now()
    m.manualHoldManager = { stopAll: jest.fn().mockResolvedValue(undefined) }
    m.valveService = { closeAllValves: jest.fn() }
    await m.wakeNextValveWaiter()
    await m.stopEventLoop()
    await jest.advanceTimersByTimeAsync(60000)
    expect(m.eventQueueService.wakeNextValveWaiter).not.toHaveBeenCalled()
  })

  it('treats wake failure as a retry, not a failed physical closure', async () => {
    const m = machine()
    m.eventQueueService.wakeNextValveWaiter.mockRejectedValueOnce(new Error('Redis down'))
    await expect(m.wakeNextValveWaiter()).resolves.toBeUndefined()
    expect(m.openValvePairId).toBeNull()
    await jest.advanceTimersByTimeAsync(DEFAULT_TIMING.VALVE_CONFLICT_RETRY_DELAY)
    expect(m.eventQueueService.wakeNextValveWaiter).toHaveBeenCalledTimes(2)
  })

  it('checks ownership after reading FIFO order from Redis', async () => {
    const m = machine(), p = request()
    m.eventQueueService.hasEarlierValveWaiter.mockImplementation(async () => {
      m.openValvePairId = 'manual:other'
      return false
    })
    expect(await m.handleValveOpenState(p, '1-1')).toBe('DELAY')
    expect(m.wateringPulseLedger.reserve).not.toHaveBeenCalled()
    expect(m.operateAutomaticPulseValve).not.toHaveBeenCalled()
  })

  it('does not let a new eligible request bypass an older waiter', async () => {
    const m = machine(), p = request(3)
    m.eventQueueService.hasEarlierValveWaiter.mockResolvedValue(true)
    expect(await m.handleValveOpenState(p, '3-3')).toBe('DELAY')
    expect(p.valveWaitOrder).toBe(3)
    expect(m.wateringPulseLedger.reserve).not.toHaveBeenCalled()
    expect(m.operateAutomaticPulseValve).not.toHaveBeenCalled()
  })

  it.each([
    ['stale reading', { lastMeasurementAt: 0 }],
    ['wet pot', { WTCPercentMeasured: 40 }],
    ['disabled watering', { ValveOpenTime: 0 }],
    ['retry spacing', { lastValveOpenedAt: 999999 }],
    ['pulse limit', { wateringWindowStartedAt: 999999, wateringWindowPulseCount: 2 }],
  ])('rechecks a woken request with %s and advances to its successor', async (_, changes) => {
    const m = machine(), p = { ...request(), ...changes }
    await m.processStateTransition({ pairing: p, newState: 'DELAY' })
    expect(m.operateAutomaticPulseValve).not.toHaveBeenCalled()
    expect(p.valveWaitOrder).toBeUndefined()
    expect(m.eventQueueService.wakeNextValveWaiter).toHaveBeenCalledTimes(1)
  })

  it('opens an eligible head only after the usual checks and clears its wait ticket', async () => {
    const m = machine(), p = request()
    await m.processStateTransition({ pairing: p, newState: 'DELAY' })
    expect(m.getLivePairing).toHaveBeenCalled()
    expect(m.wateringPulseLedger.reserve).toHaveBeenCalled()
    expect(m.operateAutomaticPulseValve).toHaveBeenCalledWith(expect.anything(), 'OPEN')
    expect(p.valveWaitOrder).toBeUndefined()
    expect(m.openValvePairId).toBe('1-1')
    expect(m.eventQueueService.wakeNextValveWaiter).not.toHaveBeenCalled()
  })
})

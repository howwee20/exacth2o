jest.mock('i2c-bus', () => ({
  openSync: jest.fn(),
}))

import StateMachine from '../StateMachine'
import { ValveService } from '../services/ValveService'
import { MachineState } from '../types'

describe('controller fail-safe transitions', () => {
  it('retires the active pulse after stop closes the valves, retaining its history', async () => {
    const machine = Object.create(StateMachine.prototype) as any
    machine.manualHoldManager = { stopAll: jest.fn().mockResolvedValue(undefined) }
    machine.state = MachineState.RUNNING
    machine.apiService = { postData: jest.fn().mockResolvedValue(undefined) }
    machine.eventQueueService = { stop: jest.fn().mockResolvedValue(undefined) }
    const order: string[] = []
    machine.valveService = { closeAllValves: jest.fn(() => order.push('closed')) }
    machine.wateringPulseLedger = {
      activePulse: () => ({ pairId: '712-1625' }),
      completeActive: jest.fn(async () => { order.push('retired') }),
    }
    await machine.stopEventLoop()
    expect(order).toEqual(['closed', 'retired'])
    expect(machine.wateringPulseLedger.completeActive).toHaveBeenCalledWith('712-1625')
    expect(machine.getState()).toBe(MachineState.STOPPED)
    expect(machine.openValvePairId).toBeNull()
  })

  it('does not report STOPPED when close-all cannot be confirmed', async () => {
    const machine = Object.create(StateMachine.prototype) as any
    machine.manualHoldManager = { stopAll: jest.fn().mockResolvedValue(undefined) }
    machine.state = MachineState.RUNNING
    machine.apiService = { postData: jest.fn().mockResolvedValue(undefined) }
    machine.eventQueueService = { stop: jest.fn().mockResolvedValue(undefined) }
    machine.valveService = {
      closeAllValves: jest.fn(() => {
        throw new Error('relay close failed')
      }),
    }
    machine.openValvePairId = '712-1625'
    machine.wateringPulseLedger = { completeActive: jest.fn() }

    await expect(machine.stopEventLoop()).rejects.toThrow('relay close failed')
    expect(machine.getState()).toBe(MachineState.RUNNING)
    expect(machine.openValvePairId).toBe('712-1625')
    expect(machine.wateringPulseLedger.completeActive).not.toHaveBeenCalled()
  })

  it('keeps a pairing in VALVE_OPEN when automatic closure is unconfirmed', async () => {
    const machine = Object.create(StateMachine.prototype) as any
    machine.apiService = { postData: jest.fn().mockResolvedValue(undefined) }
    machine.wateringPulseLedger = {
      activePulse: jest.fn(() => ({
        pairId: '712-1625',
        relayAddress: 0x20,
        address: 3,
        startedAt: Date.now(),
      })),
      completeActive: jest.fn(),
    }
    machine.closeAutomaticPulseWithFallback = jest
      .fn()
      .mockRejectedValue(new Error('relay close failed'))

    const pairing = {
      valveOpened: true,
      nextTransitionTime: null,
      Valve: { relayAddress: '0x20', address: '3' },
    }
    const result = await machine.handleValveCloseState(pairing, '712-1625')

    expect(result).toBe('VALVE_OPEN')
    expect(pairing.valveOpened).toBe(true)
    expect(machine.openValvePairId).toBe('712-1625')
    expect(machine.wateringPulseLedger.completeActive).not.toHaveBeenCalled()
  })

  it('attempts every configured valve output before reporting close-all failure', () => {
    const service = Object.create(ValveService.prototype) as any
    service.valveManager = {}
    service.valveBoardConfigs = [{ address: 0x20, resetPin: 16 }]
    service.operateValve = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('first output failed')
      })

    expect(() => service.closeAllValves()).toThrow('Failed to close 1 valve outputs')
    expect(service.operateValve.mock.calls.length).toBeGreaterThan(1)
    expect(service.operateValve.mock.calls.every((call: any[]) => call[3] === 'CLOSE')).toBe(true)
  })
})


describe('manual hold route validation', () => {
  it('checks the versioned pairing endpoint with a bounded lookup', async () => {
    process.env.EXACTH2O_MANUAL_HOLD_ENABLED = '1'
    const machine = Object.create(StateMachine.prototype) as any
    machine.apiService = {fetchData: jest.fn().mockResolvedValue({Valve:{address:'18',relayAddress:'0x24'}})}
    machine.valveService = {getBoardConfigs: () => [{address:36}]}
    machine.manualHoldManager = {request: jest.fn().mockResolvedValue({status:'closed'})}
    const request = {sessionId:'test-hold-session',ownerId:'operator',sequence:0,expiresAt:Date.now()+2000,sensorId:640,valveId:1602,address:18,relayAddress:36}
    await machine.holdManualValve('start',request)
    expect(machine.apiService.fetchData).toHaveBeenCalledWith('/v1/pairings/640/1602',{timeoutMs:750,retries:1})
    await expect(machine.holdManualValve('start',{...request,expiresAt:Date.now()-1000})).rejects.toThrow('expired')
    expect(machine.apiService.fetchData).toHaveBeenCalledTimes(1)
    delete process.env.EXACTH2O_MANUAL_HOLD_ENABLED
  })

  it('uses the server-confirmed route for pots without a sensor pairing, but still requires a configured board', async () => {
    process.env.EXACTH2O_MANUAL_HOLD_ENABLED = '1'
    const machine = Object.create(StateMachine.prototype) as any
    machine.apiService = {fetchData: jest.fn()}
    machine.valveService = {getBoardConfigs: () => [{address:32}]}
    machine.manualHoldManager = {request: jest.fn().mockResolvedValue({status:'open'})}
    const request = {routeKind:'manual',sessionId:'test-hold-session',ownerId:'operator',sequence:0,expiresAt:Date.now()+2000,address:5,relayAddress:32}
    await machine.holdManualValve('start',request)
    expect(machine.apiService.fetchData).not.toHaveBeenCalled()
    await expect(machine.holdManualValve('start',{...request,relayAddress:38})).rejects.toThrow('board unavailable')
    expect(machine.manualHoldManager.request).toHaveBeenCalledTimes(1)
    delete process.env.EXACTH2O_MANUAL_HOLD_ENABLED
  })

  it('ends an active hold before start() resets the shared valve lock', async () => {
    const machine = Object.create(StateMachine.prototype) as any
    const order: string[] = []
    machine.openValvePairId = 'hold:test-hold-session'
    machine.manualHoldManager = {stopAll: jest.fn(async () => { order.push(`stop:${machine.openValvePairId}`) })}
    machine.eventQueueService = {setLoadingPairings: jest.fn(() => { order.push(`load:${machine.openValvePairId}`); throw new Error('halt after reset') })}
    await expect(machine.start()).rejects.toThrow('halt after reset')
    expect(order).toEqual(['stop:hold:test-hold-session', 'load:null'])
  })

  it('retries a hold close, then closes every output, and keeps the lock if both fail', async () => {
    const machine = Object.create(StateMachine.prototype) as any
    const operate = jest.fn((): void => { throw new Error('relay busy') })
    const closeAll = jest.fn(() => { throw new Error('bus down') })
    machine.valveService = {calculateColumnAndPin: () => ({column:0,pin:0}), operateValve: operate, closeAllValves: closeAll}
    machine.openValvePairId = 'hold:test-hold-session'
    const request = {sessionId:'test-hold-session',ownerId:'operator',sequence:0,expiresAt:Date.now()+2000,address:5,relayAddress:32}
    await expect(machine.closeManualHold(request)).rejects.toThrow('bus down')
    expect(operate).toHaveBeenCalledTimes(3)
    expect(closeAll).toHaveBeenCalledTimes(1)
    expect(machine.openValvePairId).toBe('hold:test-hold-session')
    operate.mockImplementationOnce(() => undefined)
    await machine.closeManualHold(request)
    expect(machine.openValvePairId).toBeNull()
  })

  it('never closes a valve that belongs to automatic watering', async () => {
    const machine = Object.create(StateMachine.prototype) as any
    machine.valveService = {calculateColumnAndPin: jest.fn(), operateValve: jest.fn(), closeAllValves: jest.fn()}
    machine.openValvePairId = '712-1625'
    await machine.closeManualHold({sessionId:'test-hold-session',ownerId:'operator',sequence:0,expiresAt:0,address:5,relayAddress:32})
    expect(machine.valveService.operateValve).not.toHaveBeenCalled()
    expect(machine.openValvePairId).toBe('712-1625')
  })
})

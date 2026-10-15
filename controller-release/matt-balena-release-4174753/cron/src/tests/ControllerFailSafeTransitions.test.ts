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

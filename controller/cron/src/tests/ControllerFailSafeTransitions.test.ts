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
  const inventory = [{ relayAddress: '0x24', address: '18' }, { relayAddress: '0x20', address: '5' }]
  const holdMachine = () => {
    const machine = Object.create(StateMachine.prototype) as any
    machine.state = MachineState.RUNNING
    machine.openValvePairId = null
    machine.valveInventory = null
    machine.apiService = { fetchData: jest.fn().mockResolvedValue(inventory) }
    machine.valveService = { getBoardConfigs: () => [{ address: 36 }, { address: 32 }] }
    return machine
  }

  it('checks the requested output against the controller valve inventory with a bounded lookup', async () => {
    const machine = holdMachine()
    await machine.assertConfiguredOutput({ relayAddress: 36, address: 18, kind: 'pot' })
    expect(machine.apiService.fetchData).toHaveBeenCalledWith('/v1/valves', { timeoutMs: 1500, retries: 0 })
    await expect(machine.assertConfiguredOutput({ relayAddress: 36, address: 19, kind: 'solenoid' })).rejects.toThrow('not in the controller valve inventory')
    // The inventory is cached; a burst of starts does not re-read it.
    expect(machine.apiService.fetchData).toHaveBeenCalledTimes(1)
  })

  it('requires a configured board before any lookup, and fails closed when the inventory is unreadable', async () => {
    const machine = holdMachine()
    await expect(machine.assertConfiguredOutput({ relayAddress: 38, address: 5, kind: 'solenoid' })).rejects.toThrow('board unavailable')
    expect(machine.apiService.fetchData).not.toHaveBeenCalled()
    machine.apiService.fetchData.mockRejectedValueOnce(new Error('api down'))
    await expect(machine.assertConfiguredOutput({ relayAddress: 32, address: 5, kind: 'solenoid' })).rejects.toThrow('inventory unavailable')
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

  it('retries a hold close, then closes every output, and throws (keeping the lock) if both fail', async () => {
    const machine = Object.create(StateMachine.prototype) as any
    const operate = jest.fn((): void => { throw new Error('relay busy') })
    const closeAll = jest.fn(() => { throw new Error('bus down') })
    machine.valveService = {calculateColumnAndPin: () => ({column:0,pin:0}), operateValve: operate, closeAllValves: closeAll}
    machine.openValvePairId = 'hold:test-hold-session'
    const session = {sessionId:'test-hold-session',ownerId:'operator',route:{relayAddress:32,address:5,kind:'pot'}}
    await expect(machine.closeManualHold(session)).rejects.toThrow('bus down')
    expect(operate).toHaveBeenCalledTimes(3)
    expect(closeAll).toHaveBeenCalledTimes(1)
    // The manager keeps the session (and the lock) in fault until a close succeeds.
    expect(machine.openValvePairId).toBe('hold:test-hold-session')
    operate.mockImplementationOnce(() => undefined)
    await machine.closeManualHold(session)
    machine.arbiter = { endManualControl: jest.fn() }
    machine.releaseManualHold(session, 'released')
    expect(machine.openValvePairId).toBeNull()
  })

  it('never closes a valve that belongs to automatic watering', async () => {
    const machine = Object.create(StateMachine.prototype) as any
    machine.valveService = {calculateColumnAndPin: jest.fn(), operateValve: jest.fn(), closeAllValves: jest.fn()}
    machine.openValvePairId = '712-1625'
    await machine.closeManualHold({sessionId:'test-hold-session',ownerId:'operator',route:{relayAddress:32,address:5,kind:'pot'}})
    expect(machine.valveService.operateValve).not.toHaveBeenCalled()
    expect(machine.openValvePairId).toBe('712-1625')
  })
})

describe('relay board cleanup', () => {
  it('releases every active-low relay instead of energizing all outputs', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Expand13Controller } = require('../controllers/Expand13Controller')
    const writes: number[][] = []
    const board = Object.create(Expand13Controller.prototype)
    board.address = 0x20
    board.portState = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    board.bus = { i2cWriteSync: (_address: number, _length: number, buffer: Buffer) => { writes.push(Array.from(buffer)) }, closeSync: () => undefined }
    board.activatePin(0, 2)
    expect(writes.at(-1)).toEqual([0xfb, 0xff, 0xff, 0xff, 0xff, 0xff])
    board.cleanup()
    expect(writes.at(-1)).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  })
})

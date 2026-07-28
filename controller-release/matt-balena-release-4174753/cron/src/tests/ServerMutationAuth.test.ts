import StateMachine from '../StateMachine'
import { createServer } from '../server'

describe('cron mutation authentication', () => {
  const originalSecret = process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET
    } else {
      process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET = originalSecret
    }
  })

  function stateMachineStub(): StateMachine {
    return {
      calculateColumnAndPin: jest.fn(() => ({ column: 0, pin: 0 })),
      operateValve: jest.fn(),
      pulseManualValve: jest.fn(),
      getState: jest.fn(() => 'STOPPED'),
      getBoardConfigs: jest.fn(() => []),
      setBoardConfigs: jest.fn(),
      setState: jest.fn(),
      operateSensor: jest.fn(),
    } as unknown as StateMachine
  }

  it('rejects unauthenticated mutations while preserving read-only state access', async () => {
    process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET = 'controller-secret'
    const stateMachine = stateMachineStub()
    const server = createServer(stateMachine, {
      environment: 'test',
      port: 3000,
      apiURL: 'http://api_svc:8888/v1',
      pathPrefix: 'v1',
    })

    try {
      const valveResponse = await server.inject({
        method: 'POST',
        url: '/v1/valves',
        payload: { relayAddress: '0x20', address: 3, state: 'CLOSE' },
      })
      expect(valveResponse.statusCode).toBe(401)
      expect(stateMachine.operateValve).not.toHaveBeenCalled()

      const stateMutation = await server.inject({
        method: 'POST',
        url: '/v1/state',
        payload: { state: 'STOPPED' },
      })
      expect(stateMutation.statusCode).toBe(401)

      const stateRead = await server.inject({ method: 'GET', url: '/v1/state' })
      expect(stateRead.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('allows authenticated CLOSE but rejects an untimed raw OPEN', async () => {
    process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET = 'controller-secret'
    const stateMachine = stateMachineStub()
    const server = createServer(stateMachine, {
      environment: 'test',
      port: 3000,
      apiURL: 'http://api_svc:8888/v1',
      pathPrefix: 'v1',
    })
    const headers = { 'x-exacth2o-controller-secret': 'controller-secret' }

    try {
      const openResponse = await server.inject({
        method: 'POST',
        url: '/v1/valves',
        headers,
        payload: { relayAddress: '0x20', address: 3, state: 'OPEN' },
      })
      expect(openResponse.statusCode).toBe(410)

      const closeResponse = await server.inject({
        method: 'POST',
        url: '/v1/valves',
        headers,
        payload: { relayAddress: '0x20', address: 3, state: 'CLOSE' },
      })
      expect(closeResponse.statusCode).toBe(200)
      expect(stateMachine.operateValve).toHaveBeenCalledWith(0x20, 0, 0, 'CLOSE')
    } finally {
      await server.close()
    }
  })
})

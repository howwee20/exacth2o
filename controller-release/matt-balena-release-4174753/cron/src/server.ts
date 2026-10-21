import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyCors from '@fastify/cors'
import { MachineState } from './types'
import StateMachine from './StateMachine'
import { BoardConfig } from './controllers/Expand13Manager'
import { timingSafeEqual } from 'crypto'
import { HoldError } from './services/ManualHoldManager'

interface IAPIResponse {
  message: string
  data?: any
}

const getSensors = async (stateMachine: StateMachine, boardSerialId: string, sensorAddress: string, measurements: number): Promise<IAPIResponse> => {
  try {
    console.log(`Calling statemachine to operateSensor(boardSerialId: ${boardSerialId}, sensorAddress: ${sensorAddress}, measurements: ${measurements})`)
    const sensor = await stateMachine.operateSensor(boardSerialId, sensorAddress, measurements)
    if (sensor) {
      return { message: `boardSerialId: ${boardSerialId},sensor: ${sensorAddress}`, data: sensor }
    } else {
      throw new Error('Sensor not found')
    }
  } catch (error) {
    throw new Error('Internal Server Error')
  }
}

const operateValve = async (stateMachine: StateMachine, relayAddress: string, address: number, state: 'OPEN' | 'CLOSE'): Promise<IAPIResponse> => {
  const boardAddress = Number.parseInt(relayAddress, 16)
  const { pin, column } = stateMachine.calculateColumnAndPin(address)
  try {
    await stateMachine.operateValve(boardAddress, column, pin, state)
    return { message: `Valve ${state} command sent to relay ${relayAddress}, address ${address}` }
  } catch (error) {
    throw new Error('Internal Server Error')
  }
}

const operateState = async (stateMachine: StateMachine, state: MachineState): Promise<IAPIResponse> => {
  try {
    await stateMachine.setState(state)
    return { message: `State ${state} command sent` }
  } catch (error) {
    throw new Error('Internal Server Error')
  }
}


/**
 * Creates a Fastify server with the given state machine and options.
 * @param {StateMachine} stateMachine - The state machine instance.
 * @param {Object} options - The options for the server.
 * @param {string} options.environment - The environment (development, production, test).
 * @param {number} options.port - The port to listen on.
 * @param {string} options.apiURL - The API URL.
 * @param {string} options.pathPrefix - The path prefix for the API routes.
 * @returns {FastifyInstance} - The Fastify server instance.
 */

export function createServer(stateMachine: StateMachine, options: { environment: string, port: number, apiURL: string, pathPrefix: string }): FastifyInstance {
  const { environment, pathPrefix } = options

  const envToLogger: any = {
    development: {
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    },
    production: true,
    test: false,
  }

  const server = fastify({
    logger: envToLogger[environment] ?? true
  })

  server.register(fastifyCors, {
    origin: true,
  })

  const controllerSecret = String(process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET || '')
  const hasControllerSecret = (request: FastifyRequest): boolean => {
    const supplied = String(request.headers['x-exacth2o-controller-secret'] || '')
    if (!controllerSecret || !supplied) return false
    const expectedBuffer = Buffer.from(controllerSecret)
    const suppliedBuffer = Buffer.from(supplied)
    return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
  }
  const requireControllerSecret = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): boolean => {
    if (hasControllerSecret(request)) return true
    reply.status(401).send({ message: 'Controller command authentication required' })
    return false
  }

  server.get(`/${pathPrefix}/sensors`, async (request: FastifyRequest<{ Querystring: { boardSerialId: string, sensorAddress: string, measurements?: number } }>, reply: FastifyReply) => {
    const { boardSerialId, sensorAddress } = request.query
    const measurements = request.query?.measurements || 1

    try {
      const sensor = await getSensors(stateMachine, boardSerialId, sensorAddress, measurements)
      return reply.status(200).send(sensor)
    } catch (error) {
      server.log.error(error)
      return reply.status(500).send({ message: 'Internal Server Error' })
    }
  })

  server.post(`/${pathPrefix}/valves`, async (request: FastifyRequest<{ Body: { relayAddress: string, address: number, state: 'OPEN' | 'CLOSE' } }>, reply: FastifyReply) => {
    if (!requireControllerSecret(request, reply)) return
    const { relayAddress, address, state } = request.body
    if (state !== 'CLOSE') {
      return reply.status(410).send({
        message: 'Untimed valve OPEN is disabled. Use the authenticated pulse route.',
      })
    }

    try {
      const resp = await operateValve(stateMachine, relayAddress, address, state)
      return reply.status(200).send(resp)
    } catch (error) {
      server.log.error(error)
      reply.code(500).send({ message: 'Internal Server Error' })
    }
  })

  server.post(`/${pathPrefix}/valves/pulse`, async (request: FastifyRequest<{
    Body: {
      relayAddress: string | number
      address: number
      durationMilliseconds: number
      pulseId: string
      commandId: string
    }
  }>, reply: FastifyReply) => {
    if (!requireControllerSecret(request, reply)) return

    const body = request.body || ({} as any)
    const relayAddress = typeof body.relayAddress === 'string'
      ? Number.parseInt(body.relayAddress, body.relayAddress.toLowerCase().startsWith('0x') ? 16 : 10)
      : Number(body.relayAddress)
    const address = Number(body.address)
    const durationMilliseconds = Number(body.durationMilliseconds)
    const pulseId = String(body.pulseId || '').trim()
    const commandId = String(body.commandId || '').trim()

    if (!Number.isInteger(relayAddress) || relayAddress < 0 || relayAddress > 0x7f) {
      return reply.status(400).send({ message: 'relayAddress is invalid' })
    }
    if (!Number.isInteger(address) || address < 1 || address > 32) {
      return reply.status(400).send({ message: 'address is invalid' })
    }
    if (!Number.isInteger(durationMilliseconds) || durationMilliseconds < 1 || durationMilliseconds > 60_000) {
      return reply.status(400).send({ message: 'durationMilliseconds must be between 1 and 60000' })
    }
    if (!pulseId || pulseId.length > 240 || !commandId || commandId.length > 120) {
      return reply.status(400).send({ message: 'pulseId and commandId are required' })
    }

    try {
      const result = await stateMachine.pulseManualValve({
        relayAddress,
        address,
        durationMilliseconds,
        pulseId,
        commandId,
      })
      return reply.status(result.duplicate ? 200 : 202).send({
        ok: true,
        failSafe: 'controller_owned_timer',
        ...result,
      })
    } catch (error: any) {
      server.log.error(error)
      const message = error?.message || 'Manual pulse rejected'
      const conflict = message.includes('already') || message.includes('another valve') || message.includes('aggregate') || message.includes('timed pulse refused')
      return reply.status(conflict ? 409 : 500).send({ message })
    }
  })

  const holdSecretMatches = (request: FastifyRequest): boolean => {
    const expected = process.env.EXACTH2O_MANUAL_HOLD_SECRET || ''
    const supplied = String(request.headers['x-exacth2o-hold-secret'] || '')
    return Boolean(expected) && supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  }
  const holdStatus: Record<HoldError['code'], number> = { invalid: 400, owner: 403, busy: 409, late: 409, route: 409, unavailable: 409, failed: 500 }

  server.post(`/${pathPrefix}/valves/hold`, async (request: FastifyRequest<{Body: any}>, reply: FastifyReply) => {
    if (!holdSecretMatches(request)) return reply.code(401).send({error:'Hold authentication required'})
    const body: any = request.body || {}
    if (!['start','renew','stop','status'].includes(body.action)) return reply.code(400).send({error:'Invalid hold action'})
    const routed = body.action === 'start' || body.action === 'renew'
    const hasRoute = body.relayAddress !== undefined || body.address !== undefined
    if ((routed || hasRoute) && (!Number.isInteger(body.address) || body.address < 1 || body.address > 48 || !Number.isInteger(body.relayAddress) || body.relayAddress < 3 || body.relayAddress > 127)) {
      return reply.code(400).send({error:'Invalid valve route'})
    }
    if (body.destinationKind !== undefined && !['pot','solenoid'].includes(body.destinationKind)) return reply.code(400).send({error:'Invalid destination kind'})
    if (routed && !Number.isFinite(body.expiresAt)) return reply.code(400).send({error:'Hold signal expiry is required'})
    try {
      return await stateMachine.holdManualValve(body.action, body)
    } catch(error: any) {
      const code: HoldError['code'] = error instanceof HoldError ? error.code : 'failed'
      return reply.code(holdStatus[code] ?? 409).send({error:error.message || 'Hold rejected', code})
    }
  })

  // Read-only ownership snapshot for the independent valve watchdog (internal network only).
  server.get(`/${pathPrefix}/valves/arbiter`, async () => stateMachine.getArbiterStatus())

  server.get(`/${pathPrefix}/valves/pulse/:pulseId`, async (request: FastifyRequest<{ Params: { pulseId: string } }>, reply: FastifyReply) => {
    if (!requireControllerSecret(request, reply)) return
    const result = stateMachine.manualPulseStatus(String(request.params.pulseId || ''))
    return result ? reply.send(result) : reply.code(404).send({ message: 'Pulse not found' })
  })

  // A topology rewrite (atomic pairing remap) holds this lease so no hold starts mid-rewrite.
  server.post(`/${pathPrefix}/valves/config-rewrite`, async (request: FastifyRequest<{ Body: any }>, reply: FastifyReply) => {
    if (!requireControllerSecret(request, reply)) return
    const body: any = request.body || {}
    const id = String(body.id || '').slice(0, 120)
    if (!id || !['begin', 'end'].includes(body.action)) return reply.code(400).send({ message: 'Invalid rewrite lease request' })
    if (body.action === 'end') {
      stateMachine.endConfigRewrite(id)
      return reply.send({ ok: true })
    }
    const decision = stateMachine.beginConfigRewrite(id, Number(body.ttlMs))
    return decision.allowed ? reply.send({ ok: true }) : reply.code(409).send({ message: decision.reason })
  })

  server.post(`/${pathPrefix}/valves/watchdog`, async (request: FastifyRequest<{ Body: any }>, reply: FastifyReply) => {
    if (!requireControllerSecret(request, reply)) return
    const body: any = request.body || {}
    if (body.event !== 'tripped') return reply.code(400).send({ message: 'Unsupported watchdog event' })
    stateMachine.recordWatchdogTrip(String(body.reason || 'lease overrun').slice(0, 300))
    return reply.send({ ok: true })
  })

  server.post(`/${pathPrefix}/valves/reconcile`, async (request: FastifyRequest<{ Body: any }>, reply: FastifyReply) => {
    if (!requireControllerSecret(request, reply)) return
    const body: any = request.body || {}
    if (body.confirmedClosed !== true) return reply.code(400).send({ message: 'Confirm every outlet is closed first' })
    try {
      return reply.send(await stateMachine.reconcileValveFault(String(body.note || '')))
    } catch (error: any) {
      return reply.code(409).send({ message: error?.message || 'Reconciliation refused' })
    }
  })

  server.get(`/${pathPrefix}/state`, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const state = stateMachine.getState()
      return reply.status(200).send({ message: 'State retrieved successfully', data: state })
    }
    catch (error) {
      server.log.error(error)
      return reply.status(500).send({ message: 'Internal Server Error' })
    }
  })

  server.get(`/${pathPrefix}/boardConfigs`, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const boardConfigs = stateMachine.getBoardConfigs()
      return reply.status(200).send({ message: 'Board configs retrieved successfully', data: boardConfigs })
    }
    catch (error) {
      server.log.error(error)
      return reply.status(500).send({ message: 'Internal Server Error' })
    }
  })

  server.post(`/${pathPrefix}/boardConfigs`, async (request: FastifyRequest<{ Body: { boardConfigs: BoardConfig[] } }>, reply: FastifyReply) => {
    if (!requireControllerSecret(request, reply)) return
    const { boardConfigs } = request.body

    console.log('Received boardConfigs:', boardConfigs)
    try {
      if (!Array.isArray(boardConfigs)) {
        return reply.status(400).send({ message: 'Invalid boardConfigs' })
      }
      await stateMachine.setBoardConfigs(boardConfigs)
      return reply.status(200).send({ message: 'Board configs updated successfully', data: boardConfigs })
    } catch (error) {
      server.log.error(error)
      return reply.status(500).send({ message: 'Internal Server Error' })
    }
  })

  server.post(`/${pathPrefix}/state`, async (request: FastifyRequest<{ Body: { state: MachineState, boardConfig?: BoardConfig[] } }>, reply: FastifyReply) => {
    if (!requireControllerSecret(request, reply)) return
    const { state, boardConfig } = request.body
    console.log('state', state)
    console.log('boardConfig', boardConfig)

    try {
      if (!state) {
        console.error('State is required')
         // Log the error to the server log
        return reply.status(400).send({ message: 'State is required' })
      }

      if (!Object.values(MachineState).includes(state)) {
        console.error('Invalid state value:', state)
        return reply.status(400).send({ message: `Invalid state value: ${state}` })
      }

      if (boardConfig && !Array.isArray(boardConfig)) {
        console.error('Invalid boardConfig:', boardConfig)
         // Log the error to the server log
        return reply.status(400).send({ message: 'Invalid boardConfig' })
      }

      if (boardConfig) {
        // Set the board configs in the state machine
        console.log('Setting board configs:', boardConfig)
        await stateMachine.setBoardConfigs(boardConfig)
      }

      let desiredState: MachineState = MachineState.STOPPED

      switch (state) {
        case MachineState.STARTUP:
          desiredState = MachineState.STARTUP
          break
        case MachineState.RUNNING:
          desiredState = MachineState.RUNNING
          break
        case MachineState.STOPPED:
          desiredState = MachineState.STOPPED
          break
        case MachineState.UPDATE:
          desiredState = MachineState.UPDATE
          break
        case MachineState.RESET:
          desiredState = MachineState.RESET
          break
      }

      try {
        // Attempt to set the state in the state machine
        const resp = await operateState(stateMachine, desiredState)
        return reply.status(200).send(resp)
      }
      catch (error: any) {
        console.error('Error setting state in state machine:', error)
        server.log.error(error)
        return reply.status(500).send({ message: `Internal Server Error: ${error.message}` })
      }
    } catch (error) {
      server.log.error(error)
      return reply.status(500).send({ message: 'Internal Server Error' })
    }
  })

  return server
}

import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyCors from '@fastify/cors'
import { MachineState } from './types'
import StateMachine from './StateMachine'
import { BoardConfig } from './controllers/Expand13Manager'
import { timingSafeEqual } from 'crypto'

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
    const { relayAddress, address, state } = request.body

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
    if (!hasControllerSecret(request)) {
      return reply.status(401).send({ message: 'Controller command authentication required' })
    }

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
      const conflict = message.includes('already') || message.includes('another valve') || message.includes('aggregate')
      return reply.status(conflict ? 409 : 500).send({ message })
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

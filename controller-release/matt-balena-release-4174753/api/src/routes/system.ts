import { FastifyReply, FastifyRequest } from "fastify";
import Sensor from "../models/sensor";
import Valve from "../models/valve"

import System, { BoardConfig, MachineState } from "../models/system";
import { IRoute } from "../types/IRoute";
import {
  CRON_REQUEST_TIMEOUT_MS,
  SYSTEM_CRON_TIMEOUT_MS,
  fetchWithTimeout,
  sendApiError,
  withTimeout,
} from "../utils/requestTimeout";


const getSystemSingleton: () => Promise<System> = async () => {
  const defaults = {
    configuration: { boardConfigs: [] },
    state: MachineState.UNKNOWN // Ensure this is valid
  }

  return (
    await withTimeout(
      System.findOrCreate({
        where: { id: 1 },
        defaults
      }),
      'system singleton database lookup'
    )
  )[0];
};


const getSystemState = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const system = await getSystemSingleton()

    const cronStateResponse = await fetchWithTimeout(
      `${process.env.CRON_URL}/state`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      },
      'cron state fetch',
      SYSTEM_CRON_TIMEOUT_MS
    ).catch((error) => {
      console.error('cron state fetch failed:', error)
      return undefined
    })

    const boardConfigsResponse = await fetchWithTimeout(
      `${process.env.CRON_URL}/boardConfigs`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      },
      'cron boardConfigs fetch',
      SYSTEM_CRON_TIMEOUT_MS
    ).catch((error) => {
      console.error('cron boardConfigs fetch failed:', error)
      return undefined
    })

    // get the accurate state from the cron server
    if (cronStateResponse?.ok) {
      const cronState = await cronStateResponse.json()
      console.log('cronState', cronState)
      system.state = cronState?.data ?? MachineState.UNKNOWN
    }

    // get the accurate board configs from the cron server
    if (boardConfigsResponse?.ok) {
      const boardConfigs = await boardConfigsResponse.json()
      system.configuration.boardConfigs = boardConfigs.data
    }

    if(cronStateResponse?.ok || boardConfigsResponse?.ok) {
      await withTimeout(system.save(), 'system state save') // to keep system state in sync with cron server
    }

    reply.send(system)
  } catch (error) {
    sendApiError(reply, error, 'Get system state')
  }
}

const setSystemState = async (request: FastifyRequest<{ Body: { state?: MachineState, configuration?: System['configuration'] } }>, reply: FastifyReply) => {
  try {
    const system = await getSystemSingleton()
    const requestedState = request.body.state?.toUpperCase() as MachineState | undefined
    const cronWritableStates = [
      MachineState.STARTUP,
      MachineState.RUNNING,
      MachineState.STOPPED,
      MachineState.UPDATE,
      MachineState.RESET,
    ]

    if (!requestedState) {
      reply.code(400).send({ message: 'State is required' })
      return
    }

    if (!cronWritableStates.includes(requestedState)) {
      reply.code(400).send({ message: `Invalid state value: ${request.body.state}` })
      return
    }

    // Send state and boardConfig to cron server
    console.log('system.state', system.state, '->', requestedState)
    console.log('system.configuration.boardConfigs', system.configuration.boardConfigs, '-> ', request.body.configuration)
    const cronResponse = await fetchWithTimeout(
      `${process.env.CRON_URL}/state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          state: requestedState,
          boardConfig: request.body.configuration?.boardConfigs
        })
      },
      'cron state update',
      CRON_REQUEST_TIMEOUT_MS
    )

    if (!cronResponse.ok) {
      throw new Error('Failed to update cron server state')
    } else {
      system.state = requestedState
      if (request.body.configuration) { system.configuration = request.body.configuration }
    }

    await withTimeout(system.save(), 'system state save')
    reply.send(system)
  } catch (error) {
    sendApiError(reply, error, 'Set system state')
  }
}

const sendStateMachineRESET = async () => {
  //set StateMachine state to RESET
  return (
    await fetchWithTimeout(
      `${process.env.CRON_URL}/state`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ state: MachineState.RESET })
      },
      'cron reset state update',
      CRON_REQUEST_TIMEOUT_MS
    )
  )
}

const updateBoardConfigs = async (request: FastifyRequest<{ Body: { boardConfigs: BoardConfig[], updateHardwareService: boolean } }>, reply: FastifyReply) => {
  try {
    console.log('Updating board configs:', request.body.boardConfigs)
    const system = await getSystemSingleton()
    console.log('Current system configuration:', system.configuration)
    system.configuration = {
      ...system.configuration,
      boardConfigs: request.body.boardConfigs
    }
    console.log('Updated system configuration:', system.configuration)

    if (request?.body?.updateHardwareService) { // If the hardware service should be updated, send the board configs to the cron server
      // Update board configs in cron server
      const response = await fetchWithTimeout(
        `${process.env.CRON_URL}/boardConfigs`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ boardConfigs: request.body.boardConfigs })
        },
        'cron boardConfigs update',
        CRON_REQUEST_TIMEOUT_MS
      )

      if (response.ok) {
        console.log('Board configs updated in cron server successfully')
      } else {
        throw new Error('Failed to update board configs in cron server')
      }
    }

    await withTimeout(system.save(), 'system board config save')

    reply.send(system)
  } catch (error) {
    sendApiError(reply, error, 'Update board configs')
  }
}

const initializeSensors = async (request: FastifyRequest<{ Body: { } }>, reply: FastifyReply) => {
  try {
    // Delete all sensors & pairings (pairings will be automatically deleted because of my CASCADE configuration)
    await Sensor.destroy({ where: {}, });
    await Valve.destroy({ where: {}, }) //truncate: true, restartIdentity: true
    console.log('All sensors and valves deleted successfully. Resetting system state...')
    // Reset the system state

    //set StateMachine state to RESET
    const response = await sendStateMachineRESET()

    if(response.ok) {
      reply.code(200).send({ message: 'Sensors initialized' })
    } else {
      reply.code(500).send({ message: 'Failed to initialize sensors' })
    }
  } catch (error) {
    console.error(error)
    reply.code(500).send({ message: 'Internal Server Error' })
  }
}

export const getSystemStateRoute: IRoute = {
  method: 'GET',
  url: '/system',
  handler: getSystemState
}

export const setSystemStateRoute: IRoute = {
  method: 'POST',
  url: '/system/state',
  handler: setSystemState
}

export const updateBoardConfigsRoute: IRoute = {
  method: 'POST',
  url: '/system/board-configs',
  handler: updateBoardConfigs
}

export const initializeSensorsRoute: IRoute = {
  method: 'POST',
  url: '/system/initialize-sensors',
  handler: initializeSensors
}

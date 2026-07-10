'use server'
import 'server-only'
import { apiClient } from '../lib/api-client'
import { MachineState, BoardConfig } from '../lib/types'

export async function getSystemConfig() {
  try {
    const config = await apiClient.get('/system')
    return config
  } catch (error) {
    console.error('Error getting system configuration:', error)
    throw new Error('Failed to get system configuration')
  }
}

/**
 * Update the system state
 * @param state - MachineState enum value
 * @param configuration - optional configuration object
 */
export async function updateSystemState(state?: MachineState, configuration?: {
  boardConfigs?: BoardConfig[]
}) {
  try {
    if(state && !Object.values(MachineState).includes(state)) {
      throw new Error(`Invalid state value: ${state}`)
    }
    if(configuration && configuration.boardConfigs &&
      (
        !Array.isArray(configuration.boardConfigs)
        || configuration.boardConfigs.length === 0
        || configuration.boardConfigs.some((config) => {
          return isNaN(Number(config.address))
          || (config.resetPin && isNaN(Number(config.resetPin)))
        })
      )
    ) {
      throw new Error('Invalid boardConfigs values')
    }

    const response = await apiClient.post('/system/state', {
      state,
      configuration
    })
    return response
  } catch (error) {
    console.error('Error updating system state:', error)
    throw new Error('Failed to update system state')
  }
}

/**
 * Update valve I2C addresses
 * @param newAddresses - Array of hex I2C addresses as strings
 */
export async function updateValveAddresses(newAddresses: string[]) {
  try {
    if(!Array.isArray(newAddresses) || newAddresses.length === 0 || newAddresses.some((address) => typeof address !== 'string')) {
      throw new Error('Invalid newAddresses values')
    }
    const response = await apiClient.post('/system/valve-addresses', {
      newAddresses
    })
    return response
  } catch (error) {
    console.error('Error updating valve addresses:', error)
    throw new Error('Failed to update valve addresses')
  }
}

/**
 * Update board configurations
 * @param boardConfigs - Array of BoardConfig objects
 */
export async function updateBoardConfigs(boardConfigs: BoardConfig[]) {
  try {
    if(!Array.isArray(boardConfigs) || boardConfigs.some(config => typeof config.address !== 'number')) {
      throw new Error('Invalid board configurations')
    }
    const response = await apiClient.post('/system/board-configs', {
      boardConfigs,
      updateHardwareService: true // Assuming we always want to update the hardware service when updating board configs from the UI
    })
    return response
  } catch (error) {
    console.error('Error updating board configurations:', error)
    throw new Error('Failed to update board configurations')
  }
}

export async function initializeSensors() {
  try {
    const response = await apiClient.post('/system/initialize-sensors', {})
    return response
  } catch (error) {
    console.error('Error initializing sensors:', error)
    throw new Error('Failed to initialize sensors')
  }
}
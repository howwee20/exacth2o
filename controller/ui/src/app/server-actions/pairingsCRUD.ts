'use server'
import 'server-only'
import { apiClient } from '../lib/api-client'
import { Pairing } from '../lib/types'
export async function getAllPairings(): Promise<Pairing[]> {
  try {
    const pairings: Pairing[] = await apiClient.get('/pairings')
    return pairings
  } catch (error) {
    console.error('Error fetching all pairings:', error)
    throw new Error('Failed to fetch pairings')
  }
}

export async function getPairingById(sensorId: number, valveId: number): Promise<Pairing> {
  try {
    const pairing: Pairing = await apiClient.get(`/pairings/${sensorId}/${valveId}`)
    return pairing
  } catch (error) {
    console.error(`Error fetching pairing with sensorId ${sensorId} and valveId ${valveId}:`, error)
    throw new Error('Failed to fetch pairing')
  }
}

export async function createPairing(pairing: Pairing): Promise<Pairing> {
  try {
    const response = await apiClient.post('/pairings', pairing)
    return response
  } catch (error) {
    console.error('Error creating pairing:', error)
    throw new Error('Failed to create pairing')
  }
}

export async function updatePairing(sensorId: number, valveId: number, updatedPairing: Partial<Pairing>): Promise<Pairing> {
  try {
    const response = await apiClient.put(`/pairings/${sensorId}/${valveId}`, updatedPairing)
    return response
  } catch (error) {
    console.error(`Error updating pairing with sensorId ${sensorId} and valveId ${valveId}:`, error)
    throw new Error('Failed to update pairing')
  }
}


export async function setCalibrationId(sensorId: number, valveId: number, calibrationId: number | undefined): Promise<Pairing> {
  try {
    // Specialized version for setting the calibration ID
    const response = await apiClient.put(`/pairings/${sensorId}/${valveId}`, { calibrationId })
    console.log(`Calibration ID set for pairing with sensorId ${sensorId} and valveId ${valveId}:`, response)
    return response
  } catch (error) {
    console.error(`Error setting calibration ID for pairing with sensorId ${sensorId} and valveId ${valveId}:`, error)
    throw new Error('Failed to set calibration ID')
  }
}

export async function deletePairing(sensorId: number, valveId: number): Promise<number> {
  try {
    const response = await apiClient.delete(`/pairings/${sensorId}/${valveId}`)
    return response as number // assuming mariadb returns the number of rows deleted
  } catch (error) {
    console.error(`Error deleting pairing for sensorId ${sensorId} and valveId ${valveId}:`, error)
    throw new Error('Failed to delete pairing')
  }
}
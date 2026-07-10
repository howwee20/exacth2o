'use server'
import 'server-only'
import { apiClient } from '../lib/api-client'

// Type for creating calibration
interface CalibrationCreateParams {
  name: string;
  polynomialCoefficientsCommaDelimited: string;
  readingsJSONString: string;
}

// Check if a calibration name already exists
export async function checkCalibrationNameExists(name: string): Promise<boolean> {
  try {
    const response = await apiClient.get(`/calibrations/check-name/${encodeURIComponent(name)}`)
    return response.exists
  } catch (error) {
    console.error('Error checking calibration name:', error)
    return false
  }
}

// Create a new calibration
export async function createCalibration(params: CalibrationCreateParams) {
  try {
    const response = await apiClient.post('/calibrations', params)
    return response
  } catch (error) {
    console.error('Error creating calibration:', error)
    throw new Error('Failed to create calibration')
  }
}

// Get all calibrations
export async function getCalibrations() {
  try {
    const calibrations = await apiClient.get('/calibrations')
    return calibrations
  } catch (error) {
    console.error('Error fetching calibrations:', error)
    return []
  }
}

// Get a calibration by ID
export async function getCalibrationById(id: number) {
  try {
    const calibration = await apiClient.get(`/calibrations/${id}`)
    return calibration
  } catch (error) {
    console.error(`Error fetching calibration with id ${id}:`, error)
    throw new Error('Failed to fetch calibration')
  }
}

// Delete a calibration
export async function deleteCalibration(id: number) {
  try {
    const response = await apiClient.delete(`/calibrations/${id}`)
    return response
  } catch (error) {
    console.error(`Error deleting calibration with id ${id}:`, error)
    throw new Error('Failed to delete calibration')
  }
}
'use server'
import 'server-only'
import { apiClient } from '../lib/api-client'
import { Zone } from '../lib/types'

export async function getAllZones(): Promise<Zone[]> {
  try {
    const zones: Zone[] = await apiClient.get('/zones')
    return zones
  } catch (error) {
    console.error('Error fetching all zones:', error)
    throw new Error('Failed to fetch zones')
  }
}

export async function getZoneById(id: string): Promise<Zone[]> {
  try {
    const zone: Zone[] = await apiClient.get(`/zones/${id}`)
    return zone
  } catch (error) {
    console.error(`Error fetching zone with id ${id}:`, error)
    throw new Error('Failed to fetch zone')
  }
}

export async function createZone(zone: Omit<Zone, 'id'>): Promise<Zone> {
  try {
    const response = await apiClient.post('/zones', zone)
    return response
  } catch (error) {
    console.error('Error creating zone:', error)
    throw new Error('Failed to create zone')
  }
}

export async function updateZone(id: string, newZone: Omit<Zone, 'id'>): Promise<Zone> {
  try {
    const response = await apiClient.put(`/zones/${id}`, newZone)
    return response
  } catch (error) {
    console.error(`Error updating zone with id ${id}:`, error)
    throw new Error('Failed to update zone')
  }
}

export async function deleteZone(id: string): Promise<number> {
  try {
    const response = await apiClient.delete(`/zones/${id}`)
    return response as number // assuming mariadb returns the number of rows deleted
  } catch (error) {
    console.error(`Error deleting zone with id ${id}:`, error)
    throw new Error('Failed to delete zone')
  }
}
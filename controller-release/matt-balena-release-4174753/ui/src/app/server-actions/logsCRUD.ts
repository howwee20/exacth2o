'use server'
import 'server-only'
import { apiClient } from '../lib/api-client'
import { Log } from '../lib/types'

export async function getAllLogs(): Promise<Log[]> {
  try {
    const logs: Log[] = await apiClient.get('/logs')
    return logs
  } catch (error) {
    console.error('Error fetching all logs:', error)
    throw new Error('Failed to fetch logs')
  }
}

export async function getRecentLogs(limit: number = 100): Promise<Log[]> {
  try {
    const filter = { limit }
    const logs: Log[] = await apiClient.post('/logs/search', filter)
    return logs
  } catch (error) {
    console.error('Error fetching recent logs:', error)
    throw new Error('Failed to fetch recent logs')
  }
}

export async function getRegularLogs(limit: number = 100): Promise<Log[]> {
  try {
    const filter = {
      limit: limit * 2
    }
    const logs: Log[] = await apiClient.post('/logs/search', filter)
    return logs.filter(log => log.level !== 'error')
      .slice(0, limit);
  } catch (error) {
    console.error('Error fetching regular logs:', error)
    throw new Error('Failed to fetch regular logs')
  }
}

export async function getErrorLogs(limit: number = 100): Promise<Log[]> {
  try {
    const filter = {
      level: 'error',
      limit
    }
    const logs: Log[] = await apiClient.post('/logs/search', filter)
    return logs
  } catch (error) {
    console.error('Error fetching error logs:', error)
    throw new Error('Failed to fetch error logs')
  }
}

export async function getLogById(id: number): Promise<Log> {
  try {
    const log: Log = await apiClient.get(`/logs/${id}`)
    return log
  } catch (error) {
    console.error(`Error fetching log with id ${id}:`, error)
    throw new Error('Failed to fetch log')
  }
}

export async function createLog(newLog: Omit<Log, 'id' | 'createdAt' | 'updatedAt'>): Promise<Log> {
  try {
    const response = await apiClient.post('/logs', newLog)
    return response
  } catch (error) {
    console.error('Error creating log:', error)
    throw new Error('Failed to create log')
  }
}

export async function deleteLog(id: number): Promise<number> {
  try {
    const response = await apiClient.delete(`/logs/${id}`);
    return response;
  } catch (error) {
    console.error('Error deleting log:', error)
    throw new Error('Failed to delete log')
  }
}

export async function getLogsByFilter(filter: Record<string, unknown>): Promise<Log[]> {
  try {
    const logs: Log[] = await apiClient.post('/logs/search', filter)
    return logs
  } catch (error) {
    console.error('Error fetching logs by filter:', error)
    throw new Error('Failed to fetch logs by filter')
  }
}

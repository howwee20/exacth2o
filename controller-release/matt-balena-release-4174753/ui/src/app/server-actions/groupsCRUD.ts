'use server'
import 'server-only'
import { apiClient } from '../lib/api-client'
import { Group } from '../lib/types'

export async function getAllGroups(): Promise<Group[]> {
  try {
    const groups: Group[] = await apiClient.get('/groups')
    return groups
  } catch (error) {
    console.error('Error fetching all groups:', error)
    throw new Error('Failed to fetch groups')
  }
}

export async function getGroupById(id: number): Promise<Group> {
  try {
    const group: Group = await apiClient.get(`/groups/${id}`)
    return group
  } catch (error) {
    console.error(`Error fetching group with id ${id}:`, error)
    throw new Error('Failed to fetch group')
  }
}

export async function createGroup(group: Omit<Group, 'id'>): Promise<Group | {error: string}> {
  try {
    const response = await apiClient.post('/groups', group)
    return response
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if(error?.message?.includes('Group name already exists')) {
      return {error: 'Group name already exists'}
    }
    console.error('Error creating group:', error)
    throw new Error('Failed to create group')
  }
}

export async function updateGroup(id: number, newGroup: Omit<Group, 'id'>): Promise<Group | {error: string}> {
  try {
    const response = await apiClient.put(`/groups/${id}`, newGroup)
    return response
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if(error?.message?.includes('Group name already exists')) {
      return {error: 'Group name already exists'}
    }
    console.error(`Error updating group with id ${id}:`, error)
    throw new Error('Failed to update group')
  }
}

export async function deleteGroup(id: number): Promise<{message: string, numRowsDeleted: number}> {
  try {
    const response = await apiClient.delete(`/groups/${id}`)
    return response as {message: string, numRowsDeleted: number}
  } catch (error) {
    console.error(`Error deleting group with id ${id}:`, error)
    throw new Error('Failed to delete group')
  }
}
'use server'
import 'server-only'
import { apiClient } from '../lib/api-client'
import { Rule } from '../lib/types'


export async function getAllRules(): Promise<Rule[]> {
  try {
    const rules: Rule[] = await apiClient.get('/rules')
    return rules
  } catch (error) {
    console.error('Error fetching all rules:', error)
    throw new Error('Failed to fetch rules')
  }
}

export async function getRuleById(id: string): Promise<Rule[]> {
  try {
    const rule: Rule[] = await apiClient.get(`/rules/${id}`)
    return rule
  } catch (error) {
    console.error(`Error fetching rule with id ${id}:`, error)
    throw new Error('Failed to fetch rule')
  }
}

export async function createRule(id: string, newRule: Omit<Rule, 'id'>): Promise<Rule> {
  try {
    const response = await apiClient.post('/rules', newRule)
    return response
  } catch (error) {
    console.error('Error creating rule:', error)
    throw new Error('Failed to create rule')
  }
}

export async function updateRule(id: string, newRule: Omit<Rule, 'id'>): Promise<Rule> {
  try {
    const response = await apiClient.put(`/rules/${id}`, newRule)
    return response
  } catch (error) {
    console.error(`Error updating rule with id ${id}:`, error)
    throw new Error('Failed to update rule')
  }
}

export async function deleteRule(id: string): Promise<number> {
  try {
    const response = await apiClient.delete(`/rules/${id}`)
    return response as number //assuming maria db returns the number of rows deleted
  } catch (error) {
    console.error(`Error deleting rule with id ${id}:`, error)
    throw new Error('Failed to delete rule')
  }
}

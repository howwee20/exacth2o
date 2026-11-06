'use server'

import 'server-only'
import { apiClient } from '@/app/lib/api-client'
import { ValveAction } from '../lib/types'

export async function operateValve(address: string, relayAddress: string, operation: ValveAction) {
  try {
    const result = await apiClient.post('/valves/operate', {
      address,
      relayAddress,
      operation
    });

    return result;
  } catch (error) {
    console.error('Error operating valve:', error);
    throw new Error('Failed to operate valve');
  }
}
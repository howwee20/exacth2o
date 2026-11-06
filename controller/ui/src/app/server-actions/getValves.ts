'use server'

import 'server-only'
import { apiClient } from '@/app/lib/api-client'
import { Valve } from '@/app/lib/types';

export async function getConnectedValves(): Promise<Valve[]> {
  try {
    const valves: Valve[] = await apiClient.get('/valves') as Valve[];
    // .filter(valve => valve.address !== null)

    return valves;
  } catch (error) {
    console.error('Error fetching connected Valves:', error);
    throw new Error('Failed to fetch connected Valves');
  }
}

export async function getAllValves(): Promise<Valve[]> {
  try {
    const valves: Valve[] = await apiClient.get('/valves') as Valve[];

    return valves;
  } catch (error) {
    console.error('Error fetching Valves:', error);
    throw new Error('Failed to fetch Valves');
  }
}
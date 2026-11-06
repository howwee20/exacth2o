'use server'

import 'server-only'
import { apiClient } from '@/app/lib/api-client'
import { Sensor } from '@/app/lib/types';


export async function getConnectedSensors(): Promise<Sensor[]> {
  try {
    const sensors: Sensor[] = await apiClient.get('/sensors') as Sensor[];
    //.filter(sensor => sensor.address !== null)

    return sensors;
  } catch (error) {
    console.error('Error fetching connected sensors:', error);
    throw new Error('Failed to fetch connected sensors');
  }
}

export async function getAllSensors(): Promise<Sensor[]> {
  try {
    const sensors: Sensor[] = await apiClient.get('/sensors') as Sensor[];

    return sensors;
  } catch (error) {
    console.error('Error fetching sensors:', error);
    throw new Error('Failed to fetch sensors');
  }
}

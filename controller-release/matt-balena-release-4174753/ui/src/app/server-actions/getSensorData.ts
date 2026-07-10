'use server'

import 'server-only'
import { ApiClient } from '@/app/lib/api-client'
import { Sensor } from '../lib/types';

export async function getSensorData() {
  try {
    const apiClient = new ApiClient();
    const sensors: Sensor[] = await apiClient.get('/sensors') as Sensor[];

    return sensors;
  } catch (error) {
    console.error('Error fetching sensors:', error);
    throw new Error('Failed to fetch sensors');
  }
}
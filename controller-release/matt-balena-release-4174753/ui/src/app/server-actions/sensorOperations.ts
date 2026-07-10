'use server'

import 'server-only'
import { ApiClient } from '@/app/lib/api-client'

export async function getSensorDirectReading(id: number, measurements: number = 1) {
  try {
    const apiClient = new ApiClient();
    const result = await apiClient.get(`/sensors/${id}/direct-reading/${measurements}`);
    console.log('Sensor direct reading result:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('Error getting sensor direct reading:', error);
    throw new Error('Failed to get sensor direct reading');
  }
}
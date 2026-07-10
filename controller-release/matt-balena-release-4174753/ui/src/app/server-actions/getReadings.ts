'use server'

import 'server-only'
import { ApiClient } from '@/app/lib/api-client'
import { Reading, PaginatedResponse } from '@/app/lib/types';

export async function getReadings(page: number = 1, pageSize: number = 100, sensorIds?: number[]) {
  try {
    const apiClient = new ApiClient();

    // If sensorIds are provided, use the filtered endpoint
    if (sensorIds && sensorIds.length > 0) {
      return getReadingsWithFilters(sensorIds, undefined, undefined, page, pageSize);
    }

    // Otherwise use the regular endpoint
    const response: PaginatedResponse<Reading> = await apiClient.get(`/readings?page=${page}&pageSize=${pageSize}`) as PaginatedResponse<Reading>;
    return response;
  } catch (error) {
    console.error('Error fetching sensor readings:', error);
    throw new Error('Failed to fetch sensor readings');
  }
}

export async function getReadingsWithFilters(
  sensorIds?: number[],
  startDate?: string,
  endDate?: string,
  page: number = 1,
  pageSize: number = 100
): Promise<PaginatedResponse<Reading>> {
  // Validate date formats
  if (startDate && !Date.parse(startDate)) {
    throw new Error('getReadingsWithFilters | Invalid start date format');
  }
  if (endDate && !Date.parse(endDate)) {
    throw new Error('getReadingsWithFilters | Invalid end date format');
  }
  try {
    const apiClient = new ApiClient();
    const response: PaginatedResponse<Reading> = await apiClient.post('/readings/filtered', {
      sensorIds,
      startDate: startDate ? new Date(startDate).toISOString() : undefined,
      endDate: endDate ? new Date(endDate).toISOString() : undefined,
      page,
      pageSize: pageSize ?? 100
    }) as PaginatedResponse<Reading>;

    return response;
  } catch (error) {
    console.error('Error fetching sensor readings:', error);
    throw new Error('Failed to fetch sensor readings');
  }
}

export async function getReadingTimeRange() {
  try {
    const apiClient = new ApiClient();
    const response = await apiClient.get('/readings/timerange');
    return response;
  } catch (error) {
    console.error('Error fetching reading time range:', error);
    throw new Error('Failed to fetch reading time range');
  }
}

'use client'

import useSWR from "swr"
import { Sensor } from '../lib/types'
import { getSensorData } from '../server-actions/getSensorData'

export const useSensors = (): {
  sensors: Sensor[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isValidating: boolean;
  mutate: (data?: Sensor[] | Promise<Sensor[]>, shouldRevalidate?: boolean) => void;
} => {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    'sensors',
    async () => {
      const data = await getSensorData();
      return data;
    },
    { refreshInterval: 3000 }
  )

  return {
    sensors: data,
    error,
    isLoading,
    isValidating,
    mutate
  }
}
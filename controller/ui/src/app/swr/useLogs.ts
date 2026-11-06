'use client'

import useSWR from "swr"
import { Log } from '../lib/types'
import { getAllLogs, getErrorLogs, getRegularLogs } from '../server-actions/logsCRUD'

export const useLogs = (refreshInterval: number = 5000): {
  logs: Log[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isValidating: boolean;
  mutate: (data?: Log[] | Promise<Log[]>, shouldRevalidate?: boolean) => void;
} => {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    'logs',
    async () => {
      const data = await getAllLogs();
      return data;
    },
    { refreshInterval }
  )

  return {
    logs: data,
    error,
    isLoading,
    isValidating,
    mutate
  }
}

// Hook for regular logs (non-error logs)
export const useRegularLogs = (limit: number = 100, refreshInterval: number = 5000): {
  logs: Log[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isValidating: boolean;
  mutate: (data?: Log[] | Promise<Log[]>, shouldRevalidate?: boolean) => void;
} => {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    ['regularLogs', limit],
    async () => {
      const data = await getRegularLogs(limit);
      return data;
    },
    { refreshInterval }
  )

  return {
    logs: data,
    error,
    isLoading,
    isValidating,
    mutate
  }
}

// Hook for error logs
export const useErrorLogs = (limit: number = 100, refreshInterval: number = 5000): {
  logs: Log[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isValidating: boolean;
  mutate: (data?: Log[] | Promise<Log[]>, shouldRevalidate?: boolean) => void;
} => {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    ['errorLogs', limit],
    async () => {
      const data = await getErrorLogs(limit);
      return data;
    },
    { refreshInterval }
  )

  return {
    logs: data,
    error,
    isLoading,
    isValidating,
    mutate
  }
}

// Hook for filtered logs (keeping this for backward compatibility)
export const useFilteredLogs = (filter: Record<string, unknown>, refreshInterval: number = 5000): {
  logs: Log[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isValidating: boolean;
  mutate: (data?: Log[] | Promise<Log[]>, shouldRevalidate?: boolean) => void;
} => {
  // Create a unique key based on the filter
  const filterKey = JSON.stringify(filter);

  const { data, error, isLoading, isValidating, mutate } = useSWR(
    ['filteredLogs', filterKey],
    async () => {
      const { getLogsByFilter } = await import('../server-actions/logsCRUD');
      const data = await getLogsByFilter(filter);
      return data;
    },
    { refreshInterval }
  )

  return {
    logs: data,
    error,
    isLoading,
    isValidating,
    mutate
  }
}
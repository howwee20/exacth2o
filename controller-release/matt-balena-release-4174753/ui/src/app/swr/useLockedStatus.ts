'use client'

import useSWR from "swr"
import { getSystemConfig } from "../server-actions/systemCRUD"
import { MachineState, System } from "../lib/types";

export const useSystem = (): {
  system: System | undefined;
  lockedStatus: boolean | undefined;
  error: Error | null;
  isLoading: boolean;
  isValidating: boolean;
  mutate: (data?: System | Promise<System>, shouldRevalidate?: boolean) => void;
} => {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    'systemSingleton',
    async () => {
      const data: System = await getSystemConfig();
      return data;
    },
    // { refreshInterval: 5000 }
  )

  return {
    system: data,
    lockedStatus: data?.state === MachineState.RUNNING || data?.state === MachineState.INITIALIZING,
    error,
    isLoading,
    isValidating,
    mutate
  }
}
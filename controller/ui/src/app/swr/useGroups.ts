'use client'

import useSWR from "swr"
import { Group } from '../lib/types'
import { getAllGroups } from '../server-actions/groupsCRUD'

export const useGroups = (): {
  groups: Group[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isValidating: boolean;
  mutate: (data?: Group[] | Promise<Group[]>, shouldRevalidate?: boolean) => void;
} => {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    'groups',
    async () => {
      const data = await getAllGroups();
      return data;
    },
    // { refreshInterval: 3000 }
  )

  return {
    groups: data,
    error,
    isLoading,
    isValidating,
    mutate
  }
}
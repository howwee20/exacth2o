'use client'

import useSWR from "swr"
import { Pairing } from '../lib/types'
import { getAllPairings } from '../server-actions/pairingsCRUD'

export const usePairings = (): {
  pairings: Pairing[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isValidating: boolean;
  mutate: (data?: Pairing[] | Promise<Pairing[]>, shouldRevalidate?: boolean) => void;
} => {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    'pairings',
    async () => {
      const data = await getAllPairings();
      return data;
    },
    { refreshInterval: 5000 }
  )

  console.log('usePairings data:', data)
  return {
    pairings: data,
    error,
    isLoading,
    isValidating,
    mutate
  }
}
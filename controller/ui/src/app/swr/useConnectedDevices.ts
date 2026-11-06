'use client'

import useSWR from "swr"

import { APIEndpoint, Sensor, Valve } from '../lib/types'
import { getConnectedSensors } from "../server-actions/getSensors";
import { getConnectedValves } from "../server-actions/getValves";


export const useConnectedDevices = (): {
    connectedDevices: { sensors: Sensor[], valves: Valve[] } | undefined;
    error: Error | null;
    isLoading: boolean;
    isValidating: boolean;
    mutate: (data?: { sensors: Sensor[], valves: Valve[] }, shouldRevalidate?: boolean) => void;
} => {
    const { data, error, isLoading, isValidating, mutate } = useSWR(
        [APIEndpoint.Sensors, APIEndpoint.Valves],
        async () => {
            const sensors = await getConnectedSensors()
            const valves = await getConnectedValves()

            return { sensors, valves }
        },
        // { refreshInterval: 3000 }
    )

    return {
        connectedDevices: data,
        error,
        isLoading,
        isValidating,
        mutate
    }
}

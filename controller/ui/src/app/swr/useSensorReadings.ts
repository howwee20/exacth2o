'use client'

import { useState } from 'react'
import useSWR from "swr"
import { Reading, APIEndpoint, PaginatedResponse } from '../lib/types'
import { getReadingsWithFilters, getReadingTimeRange } from "../server-actions/getReadings";

export const useSensorReadings = (
    initialPage: number = 1,
    initialPageSize: number = 100,
    selectedSensorIds?: number[],
    startDate?: string,
    endDate?: string
): {
    sensorReadings: Reading[] | undefined;
    paginationData: {
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
    } | undefined;
    timeRange: { oldest: string | null; newest: string | null } | undefined;
    error: Error | null;
    isLoading: boolean;
    isValidating: boolean;
    mutate: (data?: PaginatedResponse<Reading> | Promise<PaginatedResponse<Reading>>, shouldRevalidate?: boolean) => void;
    setPage: (page: number) => void;
    setPageSize: (pageSize: number) => void;
} => {
    const [page, setPage] = useState<number>(initialPage);
    const [pageSize, setPageSize] = useState<number>(initialPageSize);

    // Only fetch readings if there are selected sensors
    const shouldFetch = !selectedSensorIds || selectedSensorIds.length > 0;

    // Fetch sensor readings with pagination
    const {
        data: paginatedData,
        error: readingsError,
        isLoading: readingsLoading,
        isValidating: readingsValidating,
        mutate
    } = useSWR(
        shouldFetch ? [APIEndpoint.SensorReadings, page, pageSize, selectedSensorIds, startDate, endDate] : null,
        async () => {
            const data = await getReadingsWithFilters(selectedSensorIds, startDate, endDate, page, pageSize);
            return data;
        },
        {
            refreshInterval: 15000,
            dedupingInterval: 10000,
        }
    );

    // Fetch time range for the readings (oldest and newest timestamps)
    const { data: timeRangeData, error: timeRangeError } = useSWR(
        'timeRange',
        async () => {
            const data = await getReadingTimeRange();
            return data;
        },
        { refreshInterval: 30000 } // Refresh less frequently
    );

    return {
        sensorReadings: paginatedData?.data,
        paginationData: paginatedData?.pagination,
        timeRange: timeRangeData,
        error: readingsError || timeRangeError,
        isLoading: readingsLoading,
        isValidating: readingsValidating,
        mutate,
        setPage,
        setPageSize
    };
};

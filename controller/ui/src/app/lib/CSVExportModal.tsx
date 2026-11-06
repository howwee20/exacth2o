'use client'

import { useState, useEffect } from 'react'
import Modal from './Modal'
import { useSensorReadings } from '../swr/useSensorReadings'
import { formatTimestamp } from '../lib/dateUtils'

interface CSVExportModalProps {
  isOpen: boolean
  closeModal: () => void
  pairingKeys: { sensorId: number, valveId: number }[]
  currentTimeRange?: [number, number]
}

type RangeSelectionMode = 'slider' | 'manual'

export function CSVExportModal({ isOpen, closeModal, pairingKeys, currentTimeRange }: CSVExportModalProps) {
  // Range selection mode
  const [rangeMode, setRangeMode] = useState<RangeSelectionMode>('slider')

  // State for date range
  const [startDate, setStartDate] = useState<string>('')
  const [endDate, setEndDate] = useState<string>('')
  const [minDate, setMinDate] = useState<string>('')
  const [maxDate, setMaxDate] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // Get all sensor readings to determine the available date range
  const { sensorReadings } = useSensorReadings() || {}

  // Format dates for the date inputs (YYYY-MM-DDTHH:MM)
  const formatDateForInput = (date: Date) => {
    return date.toISOString().slice(0, 16)
  }

  // Set up the date range based on available sensor readings
  useEffect(() => {
    if (sensorReadings && sensorReadings.length > 0) {
      // Sort readings by date to find min and max
      const sortedReadings = [...sensorReadings].sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      )

      const earliest = new Date(sortedReadings[0].createdAt)
      const latest = new Date(sortedReadings[sortedReadings.length - 1].createdAt)

      setMinDate(formatDateForInput(earliest))
      setMaxDate(formatDateForInput(latest))

      // Only update if the user hasn't edited yet
      if(startDate === '' && endDate === '') {
        // Set default start date to 24 hours before latest reading
        const defaultStart = new Date(latest)
        defaultStart.setHours(defaultStart.getHours() - 24)

        setStartDate(formatDateForInput(defaultStart > earliest ? defaultStart : earliest))
        setEndDate(formatDateForInput(latest))
      }
    }
  }, [sensorReadings, startDate, endDate])

  // Set default range mode based on whether currentTimeRange is provided
  useEffect(() => {
    if (currentTimeRange) {
      setRangeMode('slider')
    } else {
      setRangeMode('manual')
    }
  }, [currentTimeRange])

  // Handle CSV download
  const handleDownload = async () => {
    try {
      setIsLoading(true)
      setError(null)

      let startDateValue: Date;
      let endDateValue: Date;

      if (rangeMode === 'slider' && currentTimeRange) {
        // Use the time range from the slider
        startDateValue = new Date(currentTimeRange[0]);
        endDateValue = new Date(currentTimeRange[1]);
      } else {
        // Use the manually entered dates
        if (!startDate || !endDate) {
          setError('Please select a valid date range');
          setIsLoading(false);
          return;
        }
        startDateValue = new Date(startDate);
        endDateValue = new Date(endDate);
      }
      const sensorIds = [...new Set(pairingKeys.map((key) => key.sensorId))]
      if (sensorIds.length === 0) {
        throw new Error('No sensors selected for export')
      }

      const searchParams = new URLSearchParams({
        sensorIds: sensorIds.join(','),
        startDate: startDateValue.toISOString(),
        endDate: endDateValue.toISOString()
      })
      const downloadUrl = `/api/readings/export?${searchParams.toString()}`

      // Trigger a direct streamed download from the API proxy endpoint.
      const link = document.createElement('a')
      link.href = downloadUrl
      link.setAttribute('download', `sensor-readings-${new Date().toISOString().split('T')[0]}.csv.gz`)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      closeModal()
    } catch (error) {
      console.error('Error downloading CSV:', error)
      setError('Failed to export sensor readings. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  // Check if download button should be disabled
  const isDownloadDisabled =
    isLoading ||
    (rangeMode === 'manual' && (!startDate || !endDate)) ||
    (rangeMode === 'slider' && !currentTimeRange);

  return (
    <Modal isOpen={isOpen} closeModal={closeModal} maxWidth="lg" closeButtonText={null}>
      <div className="space-y-4">
        <h3 className="text-lg font-medium">Export Sensor Readings (CSV.gz)</h3>

        <div className="p-4 bg-blue-50 text-blue-800 rounded-md">
          <p>Exporting readings for {pairingKeys.length} selected sensor(s)</p>
        </div>

        {/* Range selection options */}
        <div className="space-y-3">
          <div className="text-sm font-medium text-gray-700">Date Range Selection</div>

          {/* Slider range option */}
          <div className="flex items-start space-x-3">
            <input
              type="radio"
              id="slider-range"
              name="range-selection"
              checked={rangeMode === 'slider'}
              onChange={() => setRangeMode('slider')}
              className="mt-1 h-4 w-4 text-blue-600 focus:ring-blue-500"
              disabled={!currentTimeRange}
            />
            <div>
              <label htmlFor="slider-range" className={`block text-sm font-medium ${currentTimeRange ? 'text-gray-700' : 'text-gray-400'}`}>
                Use chart time range
              </label>
              {currentTimeRange && (
                <div className="mt-1 text-xs text-gray-500">
                  {formatTimestamp(currentTimeRange[0])} to {formatTimestamp(currentTimeRange[1])}
                </div>
              )}
              {!currentTimeRange && (
                <div className="mt-1 text-xs text-gray-400">
                  No chart time range selected
                </div>
              )}
            </div>
          </div>

          {/* Manual range option */}
          <div className="flex items-start space-x-3">
            <input
              type="radio"
              id="manual-range"
              name="range-selection"
              checked={rangeMode === 'manual'}
              onChange={() => setRangeMode('manual')}
              className="mt-1 h-4 w-4 text-blue-600 focus:ring-blue-500"
            />
            <div className="flex-grow">
              <label htmlFor="manual-range" className="block text-sm font-medium text-gray-700">
                Specify date range manually
              </label>

              <div className="mt-2 grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">
                    Start Date
                  </label>
                  <input
                    type="datetime-local"
                    value={startDate}
                    min={minDate}
                    max={endDate || maxDate}
                    onChange={(e) => {
                      setStartDate(e.target.value);
                      setRangeMode('manual');
                    }}
                    onClick={() => setRangeMode('manual')}
                    className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 ${rangeMode === 'manual' ? '' : 'opacity-50'}`}
                    disabled={rangeMode !== 'manual'}
                    step={1}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">
                    End Date
                  </label>
                  <input
                    type="datetime-local"
                    value={endDate}
                    min={startDate || minDate}
                    max={maxDate}
                    onChange={(e) => {
                      setEndDate(e.target.value);
                      setRangeMode('manual');
                    }}
                    onClick={() => setRangeMode('manual')}
                    className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 ${rangeMode === 'manual' ? '' : 'opacity-50'}`}
                    disabled={rangeMode !== 'manual'}
                    step={1}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="p-3 bg-red-50 text-red-700 rounded-md">
            {error}
          </div>
        )}

        <div className="flex justify-end space-x-3 pt-3">
          <button
            onClick={closeModal}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleDownload}
            disabled={isDownloadDisabled}
            className={`px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
              isDownloadDisabled ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {isLoading ? 'Generating...' : 'Download (CSV.gz)'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

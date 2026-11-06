'use client'

import React, { useState, useRef, useEffect } from 'react'
import { formatTimestamp12Hour } from './lib/dateUtils'

interface RangeSliderProps {
  min: number
  max: number
  onChange: (range: [number, number]) => void
  initialRange?: [number, number]
  className?: string
  label?: string
  minTimeLabel?: string
  maxTimeLabel?: string
}

export default function RangeSlider({
  min,
  max,
  onChange,
  initialRange,
  className = '',
  label,
}: RangeSliderProps) {
  const [range, setRange] = useState<[number, number]>(initialRange ?? [min, max])
  const [isDragging, setIsDragging] = useState<null | 'min' | 'max'>(null)
  const [autoUpdateRange, setAutoUpdateRange] = useState<boolean>(initialRange ? false : true)


  // Tooltip state
  const [showMinTooltip, setShowMinTooltip] = useState(false)
  const [showMaxTooltip, setShowMaxTooltip] = useState(false)

  const sliderRef = useRef<HTMLDivElement>(null)
  const rangeWidth = max - min

  // Update range when min/max changes and autoUpdateRange is true
  useEffect(() => {
    if (autoUpdateRange && (min !== 0 || max !== 1)) { // Only update if we have real data (not the default [0,1])
      setRange([min, max])
    }
  }, [autoUpdateRange, min, max])

  // Update range when initialRange prop changes (for external updates from manual inputs)
  useEffect(() => {
    if (initialRange && Array.isArray(initialRange) && initialRange.length === 2) {
      setRange(initialRange)
      setAutoUpdateRange(false) // Disable auto-update when manually controlled
    }
  }, [initialRange])

  // Handle mouse events for dragging
  useEffect(() => {
    if (!isDragging) return

    // Show the corresponding tooltip when dragging
    if (isDragging === 'min') {
      setAutoUpdateRange(false)
      setShowMinTooltip(true)
    } else {
      setAutoUpdateRange(false)
      setShowMaxTooltip(true)
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!sliderRef.current) return

      const rect = sliderRef.current.getBoundingClientRect()
      const position = (e.clientX - rect.left) / rect.width
      const value = min + position * rangeWidth

      // Constrain value between min and max
      const clampedValue = Math.max(min, Math.min(max, value))

      if (isDragging === 'min') {
        // Prevent min handle from crossing max handle
        const newMin = Math.min(clampedValue, range[1])
        setRange([newMin, range[1]])
      } else {
        // Prevent max handle from crossing min handle
        const newMax = Math.max(clampedValue, range[0])
        setRange([range[0], newMax])
      }
    }

    const handleMouseUp = () => {
      setIsDragging(null)
      // Hide tooltips on mouse up
      setShowMinTooltip(false)
      setShowMaxTooltip(false)
      // Notify parent component of the change
      onChange(range)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, min, max, range, onChange, rangeWidth])

  // Calculate positions for handles and the selection
  const minPosition = ((range[0] - min) / rangeWidth) * 100
  const maxPosition = ((range[1] - min) / rangeWidth) * 100

  // Format the timestamp for tooltips (using 12-hour AM/PM format)
  const minTimeDisplay = formatTimestamp12Hour(range[0])
  const maxTimeDisplay = formatTimestamp12Hour(range[1])

  return (
    <div className={`space-y-2 w-full ${className}`}>
      <div className="space-y-1">
        {/* Slider */}
        <div className="relative h-6 w-full" ref={sliderRef}>
          {/* Track background */}
          <div className="absolute top-1/2 -translate-y-1/2 h-1 w-full bg-gray-200 rounded-full"></div>

          {/* Selected range */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-1 bg-gray-700 rounded-full"
            style={{
              left: `${minPosition}%`,
              width: `${maxPosition - minPosition}%`
            }}
          ></div>

          {/* Min handle */}
          <div
            className="absolute top-1/2 -translate-y-1/2 -ml-2 h-4 w-4 bg-white border-2 border-gray-700 rounded-full cursor-pointer shadow"
            style={{ left: `${minPosition}%` }}
            onMouseDown={() => setIsDragging('min')}
            onMouseEnter={() => setShowMinTooltip(true)}
            onMouseLeave={() => !isDragging && setShowMinTooltip(false)}
          >
            {/* Min tooltip */}
            {showMinTooltip && (
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-800 text-white text-xs rounded whitespace-nowrap z-10">
                {minTimeDisplay}
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-gray-800"></div>
              </div>
            )}
          </div>

          {/* Max handle */}
          <div
            className="absolute top-1/2 -translate-y-1/2 -ml-2 h-4 w-4 bg-white border-2 border-gray-700 rounded-full cursor-pointer shadow"
            style={{ left: `${maxPosition}%` }}
            onMouseDown={() => setIsDragging('max')}
            onMouseEnter={() => setShowMaxTooltip(true)}
            onMouseLeave={() => !isDragging && setShowMaxTooltip(false)}
          >
            {/* Max tooltip */}
            {showMaxTooltip && (
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-2 py-1 bg-gray-800 text-white text-xs rounded whitespace-nowrap z-10">
                {maxTimeDisplay}
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-gray-800"></div>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Main label - centered below everything */}
      {label && (
        <div className="text-base text-gray-700 text-center">{label}</div>
      )}
    </div>
  )
}
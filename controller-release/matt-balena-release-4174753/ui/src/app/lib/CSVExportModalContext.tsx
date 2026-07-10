'use client'

import { createContext, useState, useContext, ReactNode } from 'react'
import { CSVExportModal } from './CSVExportModal'

interface CSVExportModalContextType {
  showCSVExportModal: (options: CSVExportModalOptions) => void
  closeCSVExportModal: () => void
}

interface CSVExportModalOptions {
  pairingKeys: { sensorId: number, valveId: number }[]
  currentTimeRange?: [number, number]
}

const CSVExportModalContext = createContext<CSVExportModalContextType | undefined>(undefined)

interface CSVExportModalProviderProps {
  children: ReactNode
}

export function CSVExportModalProvider({ children }: CSVExportModalProviderProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [currentOptions, setCurrentOptions] = useState<CSVExportModalOptions | null>(null)

  const showCSVExportModal = (options: CSVExportModalOptions) => {
    setCurrentOptions(options)
    setIsOpen(true)
  }

  const closeCSVExportModal = () => {
    setIsOpen(false)
  }

  return (
    <CSVExportModalContext.Provider value={{ showCSVExportModal, closeCSVExportModal }}>
      {children}
      {currentOptions && (
        <CSVExportModal
          isOpen={isOpen}
          closeModal={closeCSVExportModal}
          pairingKeys={currentOptions.pairingKeys}
          currentTimeRange={currentOptions.currentTimeRange}
        />
      )}
    </CSVExportModalContext.Provider>
  )
}

export function useCSVExportModal(): CSVExportModalContextType {
  const context = useContext(CSVExportModalContext)
  if (context === undefined) {
    throw new Error('useCSVExportModal must be used within a CSVExportModalProvider')
  }
  return context
}
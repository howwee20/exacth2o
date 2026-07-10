'use client'

import { ArrowPathIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { useGenericModal } from "../lib/GenericModal"
import { SpinningLoader } from "../lib/SpinningLoader"
import ProtectedLayout from "../ProtectedLayout"
import { getSystemConfig, initializeSensors, updateBoardConfigs, updateSystemState } from "../server-actions/systemCRUD"
import { BoardConfig, MachineState } from "../lib/types"
import { LogSection } from "../LogSection"
import { useGroups } from "../swr/useGroups"
import { deleteGroup } from "../server-actions/groupsCRUD"

// Helper functions for hex conversion
const numberToHex = (num: number): string => {
  return '0x' + num.toString(16).toUpperCase().padStart(2, '0')
}

const hexToNumber = (hex: string): number | null => {
  // Remove 0x prefix if present and convert to uppercase
  const cleanHex = hex.trim().replace(/^0x/i, '').toUpperCase()
  if (cleanHex === '') return null
  // Limit to 2 hex digits (0x00-0xFF range)
  if (cleanHex.length > 2) return null
  // Check if it's a valid hex string
  if (!/^[0-9A-F]+$/.test(cleanHex)) return null
  const num = parseInt(cleanHex, 16)
  return num
}

export default function SystemConfigPage() {
  const [boardConfigs, setBoardConfigs] = useState<BoardConfig[]>([{ address: 0 }])
  // State to track hex string values for address inputs
  const [addressHexValues, setAddressHexValues] = useState<string[]>(['0x00'])
  const [isUpdatingBoardConfigs, setIsUpdatingBoardConfigs] = useState(false)
  const [isInitializingSensors, setIsInitializingSensors] = useState(false)
  const [boardConfigValidationErrors, setBoardConfigValidationErrors] = useState<string[]>([])
  const [systemConfig, setSystemConfig] = useState<{
    id?: number;
    state: MachineState;
    configuration: {
      boardConfigs?: BoardConfig[];
    };
  } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [logsRefreshKey, setLogsRefreshKey] = useState(0)
  const [selectedGroupId, setSelectedGroupId] = useState<number | undefined>(undefined)
  const [selectedExportType, setSelectedExportType] = useState<string>('')
  const [isExporting, setIsExporting] = useState(false)

  const { showGenericModal } = useGenericModal()
  const router = useRouter()
  const { groups, isLoading: isGroupsLoading, mutate: mutateGroups } = useGroups()

  // Available data types for export (using streaming gzip endpoints)
  const exportOptions = [
    { value: 'groups', label: 'Groups', exportUrl: '/api/groups/export' },
    { value: 'sensors', label: 'Sensors', exportUrl: '/api/sensors/export' },
    { value: 'valves', label: 'Valves', exportUrl: '/api/valves/export' },
    { value: 'pairings', label: 'Pairings', exportUrl: '/api/pairings/export' },
    { value: 'calibrations', label: 'Calibrations', exportUrl: '/api/calibrations/export' },
    { value: 'rules', label: 'Rules', exportUrl: '/api/rules/export' },
    { value: 'logs', label: 'Logs & Errors', exportUrl: '/api/logs/export' },
  ]

  const fetchSystemConfig = async () => {
    try {
      setIsLoading(true)
      const config = await getSystemConfig()
      setSystemConfig(config)

      // If there are board configs in the config, set them in the form
      if (config.configuration?.boardConfigs?.length > 0) {
        setBoardConfigs(config.configuration.boardConfigs)
        // Initialize hex values from board configs
        setAddressHexValues(config.configuration.boardConfigs.map((c: BoardConfig) => numberToHex(c.address)))
      }
      return config
    } catch (error) {
      console.error('Error fetching system config:', error)
      return null
    } finally {
      setIsLoading(false)
    }
  }

  // Function to manually refresh the system data
  const handleRefreshSystemData = async () => {
    setIsRefreshing(true)
    await fetchSystemConfig()
    setIsRefreshing(false)
  }

  // Load system configuration on page load
  useEffect(() => {
    fetchSystemConfig()
  }, []) // Empty dependency array ensures this runs only once on mount

  const validateBoardConfigs = (configs: BoardConfig[], hexValues: string[]): boolean => {
    const errors: string[] = []

    if (configs.length === 0) {
      errors.push('At least one board configuration is required')
    }

    configs.forEach((config, index) => {
      // Validate that the hex input can be parsed to a valid number
      const parsedValue = hexToNumber(hexValues[index] || '')
      if (parsedValue === null) {
        errors.push(`Board #${index + 1} has an invalid address. Must be a hex value between 0x00-0xFF (e.g., 0x20).`)
      } else if (typeof config.address !== 'number' || config.address < 0 || config.address > 255) {
        errors.push(`Board #${index + 1} has an invalid address. Must be a hex value between 0x00-0xFF (e.g., 0x20).`)
      }

      if (config.resetPin !== undefined && (typeof config.resetPin !== 'number' || config.resetPin < 0)) {
        errors.push(`Board #${index + 1} has an invalid reset pin. Must be a positive number.`)
      }
    })

    // Check for duplicate addresses
    const addresses = configs.map(config => config.address)
    const uniqueAddresses = new Set(addresses)
    if (uniqueAddresses.size !== addresses.length) {
      errors.push('Duplicate board addresses are not allowed')
    }

    setBoardConfigValidationErrors(errors)
    return errors.length === 0
  }

  // Board Config Management
  const handleAddBoardConfig = () => {
    setBoardConfigs([...boardConfigs, { address: 0 }])
    setAddressHexValues([...addressHexValues, '0x00'])
  }

  const handleRemoveBoardConfig = (index: number) => {
    const newConfigs = [...boardConfigs]
    newConfigs.splice(index, 1)
    setBoardConfigs(newConfigs.length ? newConfigs : [{ address: 0 }])

    const newHexValues = [...addressHexValues]
    newHexValues.splice(index, 1)
    setAddressHexValues(newHexValues.length ? newHexValues : ['0x00'])
  }

  const handleBoardConfigChange = (index: number, field: keyof BoardConfig, value: number | undefined) => {
    if(value === undefined) {
      return
    }
    const newConfigs = [...boardConfigs]
    newConfigs[index] = { ...newConfigs[index], [field]: value }
    setBoardConfigs(newConfigs)
  }

  // Handler for hex address input changes
  const handleAddressHexChange = (index: number, hexValue: string) => {
    // Try to parse and update the numeric value
    const numValue = hexToNumber(hexValue)
    const newHexValues = [...addressHexValues]
    if (numValue !== null) {
      // Normalize the display value to canonical hex format
      newHexValues[index] = numberToHex(numValue)
      const newConfigs = [...boardConfigs]
      newConfigs[index] = { ...newConfigs[index], address: numValue }
      setBoardConfigs(newConfigs)
    } else {
      // If invalid, keep the raw input
      newHexValues[index] = hexValue
    }
    setAddressHexValues(newHexValues)
  }

  const handleUpdateBoardConfigs = async () => {
    if (!validateBoardConfigs(boardConfigs, addressHexValues)) {
      return
    }

    showGenericModal({
      mainText: 'Update Board Configurations',
      confirmButtonText: 'Continue',
      cancelButtonText: 'Cancel',
      subText: <span>Updating board configurations might require a system reset.<br />Are you sure you want to continue?</span>,
      onConfirmCallback: async () => {
        try {
          setIsUpdatingBoardConfigs(true)

          await updateBoardConfigs(boardConfigs)

          showGenericModal({
            mainText: 'Success',
            confirmButtonText: 'OK',
            subText: 'Board configurations updated successfully.',
            onConfirmCallback: () => {
              handleRefreshSystemData()
            }
          })
        } catch (error) {
          console.error('Error updating board configurations:', error)
          showGenericModal({
            mainText: 'Error',
            confirmButtonText: 'OK',
            subText: 'Failed to update board configurations. Please try again.',
            onConfirmCallback: () => {}
          })
        } finally {
          setIsUpdatingBoardConfigs(false)
        }
      },
      onCancelCallback() {  /*nothing, but we need to define this or it'll confirm on click away*/ },
    })
  }

  const handleInitializeSensors = () => {
    showGenericModal({
      mainText: 'Warning: This will remove all existing sensors and pairings',
      confirmButtonText: 'Continue',
      cancelButtonText: 'Cancel',
      subText: <span>Initializing sensors will remove all existing sensor configurations and pairings.<br /><strong>This action cannot be undone.</strong></span>,
      onConfirmCallback: async () => {
        try {
          setIsInitializingSensors(true)

          await initializeSensors()
          setLogsRefreshKey((k) => k + 1)

          showGenericModal({
            mainText: 'Success',
            confirmButtonText: 'OK',
            subText: 'Sensors initialized successfully.',
            onConfirmCallback: () => {
              handleRefreshSystemData()
            }
          })
        } catch (error) {
          console.error('Error initializing sensors:', error)
          showGenericModal({
            mainText: 'Error',
            confirmButtonText: 'OK',
            subText: 'Failed to initialize sensors. Please try again.',
            onConfirmCallback: () => {}
          })
        } finally {
          setIsInitializingSensors(false)
        }
      },
      onCancelCallback() {  /*nothing, but we need to define this or it'll confirm on click away*/ },
    })
  }

  // Maps MachineState enum to a user-friendly display
  const getMachineStateDisplay = (state?: MachineState) => {
    if (!state) return 'Unknown';

    const stateMap: Record<MachineState, string> = {
      [MachineState.STARTUP]: 'Starting Up',
      [MachineState.INITIALIZING]: 'Initializing',
      [MachineState.RUNNING]: 'Running',
      [MachineState.STOPPED]: 'Stopped',
      [MachineState.UPDATE]: 'Updating',
      [MachineState.RESET]: 'Resetting',
    };

    return stateMap[state] || state;
  }

  // Maps MachineState enum to CSS classes for display
  const getMachineStateClasses = (state?: MachineState) => {
    if (!state) return 'bg-gray-100 text-gray-800';

    const classMap: Record<MachineState, string> = {
      [MachineState.STARTUP]: 'bg-blue-100 text-blue-800',
      [MachineState.INITIALIZING]: 'bg-orange-100 text-orange-800',
      [MachineState.RUNNING]: 'bg-green-100 text-green-800',
      [MachineState.STOPPED]: 'bg-red-100 text-red-800',
      [MachineState.UPDATE]: 'bg-yellow-100 text-yellow-800',
      [MachineState.RESET]: 'bg-purple-100 text-purple-800',
    };

    return classMap[state] || 'bg-gray-100 text-gray-800';
  }

  // Handle data export - uses streaming gzip download with direct link for efficiency
  const handleExportData = async () => {
    if (!selectedExportType) return

    const selectedOption = exportOptions.find(option => option.value === selectedExportType)
    if (!selectedOption) return

    setIsExporting(true)
    try {
      // Direct download link to preserve streaming behavior
      const fileName = `${selectedOption.value}-${new Date().toISOString().split('T')[0]}.csv.gz`
      const link = document.createElement('a')
      link.href = selectedOption.exportUrl
      link.setAttribute('download', fileName)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (error) {
      console.error('Error exporting data:', error)
      showGenericModal({
        mainText: 'Export Error',
        confirmButtonText: 'OK',
        subText: 'Failed to export data. Please try again.',
        onConfirmCallback: () => {}
      })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <>
    <ProtectedLayout>
      <div className="container mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">System Configuration</h1>
            <p className="text-sm text-gray-500">Configure system hardware settings</p>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
          >
            Back to Dashboard
          </button>
        </div>

        {isLoading ? (
          <div className="flex justify-center items-center h-64">
            <SpinningLoader svgClassName="w-8 h-8" />
          </div>
        ) : (
          <>
            {/* System Overview Section */}
            <div className="p-6 bg-white rounded-lg border border-gray-200">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold">Current System Configuration</h2>
                <button
                  onClick={handleRefreshSystemData}
                  disabled={isRefreshing}
                  className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
                >
                  <ArrowPathIcon className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                <div className="border rounded-lg p-4 bg-gray-50">
                  <h3 className="text-md font-medium mb-2">Status</h3>
                  <div className="flex items-center">
                    <span className="text-sm font-medium mr-2">State:</span>
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      getMachineStateClasses(systemConfig?.state)
                    }`}>
                      {getMachineStateDisplay(systemConfig?.state)}
                    </span>
                  </div>
                </div>

                <div className="border rounded-lg p-4 bg-gray-50">
                  <h3 className="text-md font-medium mb-2">Configuration</h3>
                  <div>
                    <span className="text-sm font-medium">Board Configurations:</span>
                    <div className="mt-1">
                      {systemConfig?.configuration?.boardConfigs?.length ? (
                        <div className="grid grid-cols-2 gap-1">
                          {systemConfig.configuration.boardConfigs.map((board, index) => (
                            <span key={index} className="px-2 py-1 rounded-full bg-purple-100 text-purple-800 text-xs font-medium">
                              Address: {numberToHex(board.address)}{board.resetPin !== undefined ? `, Reset Pin: ${board.resetPin}` : ''}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-gray-500 italic">No board configurations</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>


            {/* Board Configurations Section */}
            <div className="p-6 bg-white rounded-lg border border-gray-200">
              <h2 className="text-xl font-semibold mb-4">Update Board Configurations</h2>
              {/*<p className="text-sm text-gray-500 mb-6">
                Configure the expansion boards in the system. Each board needs a unique address.
              </p>*/}

              {boardConfigs.map((config, index) => (
                <div key={index} className="flex items-center mb-3 gap-2">
                  <div className="flex-grow grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Address (Hex)</label>
                      <input
                        type="text"
                        value={addressHexValues[index] ?? numberToHex(config.address)}
                        placeholder="0x20"
                        onChange={(e) => handleAddressHexChange(index, e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Reset Pin (optional)</label>
                      <input
                        type="number"
                        value={config.resetPin || ''}
                        min={0}
                        onChange={(e) => {
                          const val = e.target.value === '' ? undefined : parseInt(e.target.value);
                          handleBoardConfigChange(index, 'resetPin', val);
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                  {boardConfigs.length > 1 && (
                    <button
                      onClick={() => handleRemoveBoardConfig(index)}
                      className="p-2 text-red-600 hover:text-red-800 self-end"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}

              <div className="mt-5 flex justify-between">
                <button
                  onClick={handleAddBoardConfig}
                  className="px-4 py-2 bg-gray-100 text-gray-700 border border-gray-300 rounded-md hover:bg-gray-200"
                >
                  <PlusIcon className="h-4 w-4 inline mr-1" /> Add Board
                </button>

                <button
                  onClick={handleUpdateBoardConfigs}
                  disabled={isUpdatingBoardConfigs}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed flex items-center"
                >
                  {isUpdatingBoardConfigs ? <SpinningLoader svgClassName="w-4 h-4 mr-2" /> : null}
                  Update Board Configurations
                </button>
              </div>

              {boardConfigValidationErrors.length > 0 && (
                <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-md">
                  <h4 className="text-sm font-medium text-red-800 mb-2">Please fix the following errors:</h4>
                  <ul className="list-disc pl-5 text-sm text-red-700">
                    {boardConfigValidationErrors.map((error, index) => (
                      <li key={index}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Initialize Sensors Section */}
            <div className="grid grid-cols-2 gap-6">
              <div className="p-6 bg-white rounded-lg border border-gray-200">
                <h2 className="text-xl font-semibold mb-4">Initialize Sensors</h2>
                <p className="text-sm text-gray-500 mb-6">
                  Initialize the system to detect all connected sensors. This will remove all existing sensors and pairings.
                </p>

                <div className="flex justify-end">
                  <button
                    onClick={handleInitializeSensors}
                    disabled={isInitializingSensors}
                    className="px-4 py-2 bg-yellow-600 text-white rounded-md hover:bg-yellow-700 disabled:bg-yellow-300 disabled:cursor-not-allowed flex items-center"
                  >
                    {isInitializingSensors ? <SpinningLoader svgClassName="w-4 h-4 mr-2" /> : null}
                    Initialize Sensors
                  </button>
                </div>
              </div>

              {/* Stop System Section */}
              <div className="p-6 bg-white rounded-lg border border-gray-200">
                <h2 className="text-xl font-semibold mb-4">{systemConfig?.state === MachineState.STOPPED ? 'Start System' : 'Stop System'}</h2>
                <p className="text-sm text-gray-500 mb-6">
                  {systemConfig?.state === MachineState.STOPPED ? 'Start the system to begin operation. This will lock certain edits from being made while the system is running.' : 'Stop the system from running. This will halt everything.'}
                </p>

                <div className="flex justify-end">
                  {systemConfig?.state !== MachineState.STOPPED
                  ?
                    <button
                      onClick={() => {
                        showGenericModal({
                          mainText: 'Stop System?',
                          confirmButtonText: 'Stop',
                          cancelButtonText: 'Cancel',
                          subText: 'Are you sure you want to stop the system? This will halt everything.',
                          onConfirmCallback: async () => {
                            try {
                              await updateSystemState(MachineState.STOPPED)
                              showGenericModal({
                                mainText: 'Success',
                                confirmButtonText: 'OK',
                                subText: 'System has been stopped successfully.',
                                onConfirmCallback: () => {
                                  handleRefreshSystemData()
                                }
                              })
                            } catch (error) {
                              console.error('Error stopping system:', error)
                              showGenericModal({
                                mainText: 'Error',
                                confirmButtonText: 'OK',
                                subText: 'Failed to stop system. Please try again.',
                                onConfirmCallback: () => {}
                              })
                            }
                          },
                          onCancelCallback() { /*nothing, but we need to define this or it'll confirm on click away*/ },
                        })
                      }}
                      className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
                    >
                    Stop System
                    </button>
                   :
                    <button
                      onClick={() => {
                        showGenericModal({
                          mainText: 'Start System?',
                          confirmButtonText: 'Start',
                          cancelButtonText: 'Cancel',
                          subText: 'Are you sure you want to start the system? This will lock certain edits.',
                          onConfirmCallback: async () => {
                            try {
                              await updateSystemState(MachineState.STARTUP)
                              showGenericModal({
                                mainText: 'Success',
                                confirmButtonText: 'OK',
                                subText: 'System has been started successfully.',
                                onConfirmCallback: () => {
                                  handleRefreshSystemData()
                                }
                              })
                            } catch (error) {
                              console.error('Error starting system:', error)
                              showGenericModal({
                                mainText: 'Error',
                                confirmButtonText: 'OK',
                                subText: 'Failed to start system. Please try again.',
                                onConfirmCallback: () => {}
                              })
                            }
                          },
                          onCancelCallback() { /*nothing, but we need to define this or it'll confirm on click away*/ },
                        })
                      }}
                      className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                    >
                      Start System
                    </button>
}
                </div>
              </div>

              {/* Remove Groups Section */}
              <div className="p-6 bg-white rounded-lg border border-gray-200">
                <h2 className="text-xl font-semibold mb-2">Remove groups</h2>
                <p className="text-sm text-gray-500 mb-6">
                  Select a group from the dropdown, then click the remove button to proceed.
                </p>

                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Group</label>
                    <select
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={selectedGroupId ?? ''}
                      onChange={(e) => {
                        const val = e.target.value === '' ? undefined : Number(e.target.value)
                        setSelectedGroupId(val)
                      }}
                      disabled={isGroupsLoading}
                    >
                      <option value="">Select a group</option>
                      {groups?.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  </div>

                  <button
                    className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed"
                    disabled={!selectedGroupId}
                    onClick={() => {
                      const groupName = groups?.find(g => g.id === selectedGroupId)?.name ?? ''
                      showGenericModal({
                        mainText: 'Remove group',
                        confirmButtonText: 'Remove',
                        cancelButtonText: 'Cancel',
                        subText: `Are you sure you want to remove ${groupName}?`,
                        onConfirmCallback: async () => {
                          if(selectedGroupId) {
                            // delete the group from the database
                            const deleteGroupResults = await deleteGroup(selectedGroupId)

                            if(deleteGroupResults && deleteGroupResults.numRowsDeleted === 1) {
                              showGenericModal({
                                mainText: 'Success',
                                confirmButtonText: 'OK',
                                subText: 'Group has been removed successfully.',
                                onConfirmCallback: () => {
                                  mutateGroups()
                                }
                              })
                            }
                          }
                        },
                        onCancelCallback() { /*nothing, but we need to define this or it'll confirm on click away*/ },
                      })
                    }}
                  >
                    Remove group
                  </button>
                </div>
              </div>

              {/* Export Data Section */}
              <div className="p-6 bg-white rounded-lg border border-gray-200">
                <h2 className="text-xl font-semibold mb-2">Export data</h2>
                <p className="text-sm text-gray-500 mb-6">
                  Select a data type from the dropdown, then click the export button to download as CSV.
                </p>

                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Data Type</label>
                    <select
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={selectedExportType}
                      onChange={(e) => setSelectedExportType(e.target.value)}
                    >
                      <option value="">Select data type</option>
                      {exportOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>

                  <button
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed flex items-center"
                    disabled={!selectedExportType || isExporting}
                    onClick={handleExportData}
                  >
                    {isExporting && <SpinningLoader svgClassName="w-4 h-4 mr-2" />}
                    Export (CSV.gz)
                  </button>
                </div>
              </div>
            </div>

            {/* Logs Section */}
            <LogSection key={logsRefreshKey} refreshIntervalMs={isInitializingSensors ? 1000 : 5000} />
          </>
        )}
      </div>
    </ProtectedLayout>
    </>
  )
}
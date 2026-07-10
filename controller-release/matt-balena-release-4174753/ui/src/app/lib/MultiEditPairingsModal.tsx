'use client'

import { Dispatch, ReactNode, SetStateAction, createContext, useCallback, useContext, useState, useEffect } from "react"
import Modal from "./Modal"
import { updatePairing } from "../server-actions/pairingsCRUD"
import { Pairing } from "../lib/types"
import { usePairings } from "../swr/usePairings"
import { useGroups } from "../swr/useGroups"
import { SpinningLoader } from "./SpinningLoader"
import { useSystem } from "../swr/useLockedStatus"
import { operateValve } from "../server-actions/valveOperations"
import { useConnectedDevices } from "../swr/useConnectedDevices"
import { Valve, ValveAction } from "./types"
import { useCalibrations, formatPolynomialFunction } from "../swr/useCalibrations"

export interface MultiEditPairingsModalArgs {
  onSave?: (updatedCount: number) => void
  onCloseCallback?: () => void
  pairingKeys: {sensorId: number, valveId: number}[]
}

// Create contexts for modal state management
const ModalIsShowingContext = createContext(false)
const SetModalIsShowingContext = createContext<Dispatch<SetStateAction<boolean>>>(() => {})
const ModalArgsContext = createContext<MultiEditPairingsModalArgs | null>(null)
const SetModalArgsContext = createContext<Dispatch<SetStateAction<MultiEditPairingsModalArgs | null>>>(() => {})

const CustomizedModal = () => {
  const [groupId, setGroupId] = useState("")
  const [wtcPercentLimit, setWtcPercentLimit] = useState("")
  const [valveOpenTime, setValveOpenTime] = useState("")
  const [measurementInterval, setMeasurementInterval] = useState("")
  const [selectedCalibrationId, setSelectedCalibrationId] = useState<number | undefined>(undefined)
  const [isSaving, setIsSaving] = useState(false)
  const { lockedStatus } = useSystem()
  const [manualControlsUnlocked, setManualControlsUnlocked] = useState(false)
  const [isOperatingValves, setIsOperatingValves] = useState(false)
  const { connectedDevices } = useConnectedDevices()
  const { calibrations, isLoading: isCalibrationLoading } = useCalibrations()

  // Validation error states
  const [validationErrors, setValidationErrors] = useState<{
    wtcPercentLimit?: string;
    valveOpenTime?: string;
    measurementInterval?: string;
  }>({})

  const { mutate: mutatePairings } = usePairings()
  const { groups } = useGroups()

  const {
    hideMultiEditPairingsModal,
    multiEditPairingsModalArgs,
    multiEditPairingsModalIsShowing
  } = useMultiEditPairingsModal()

  // Calculate the number of pairings being edited
  const pairingCount = multiEditPairingsModalArgs?.pairingKeys?.length || 0

  // Reset manual controls lock when modal closes or opens
  useEffect(() => {
    if (!multiEditPairingsModalIsShowing) {
      setManualControlsUnlocked(false)
    }
  }, [multiEditPairingsModalIsShowing]);

  const handleCloseModal = () => {
    setGroupId("")
    setWtcPercentLimit("")
    setValveOpenTime("")
    setMeasurementInterval("")
    setSelectedCalibrationId(undefined)
    setValidationErrors({})
    hideMultiEditPairingsModal()
    if(multiEditPairingsModalArgs?.onCloseCallback) {
      multiEditPairingsModalArgs.onCloseCallback()
    }
  }

  const handleSave = async () => {
    // Don't allow save if there are validation errors
    if (Object.keys(validationErrors).length > 0) {
      return
    }

    // Don't save if no changes were made (all fields empty)
    if (!groupId && !wtcPercentLimit && !valveOpenTime && !measurementInterval && !selectedCalibrationId) {
      console.error('No changes to apply')
      return
    }


    // Check if the system is locked
    if(lockedStatus) {
      console.error('The system is locked')
      return
    }


    setIsSaving(true)

    // Prepare the update data (only include fields that have values)
    const updateData: Partial<Pairing> = {}

  if (groupId) updateData.groupId = parseInt(groupId)
  if (wtcPercentLimit) updateData.WTCPercentLimit = parseInt(wtcPercentLimit)
  // Convert seconds to milliseconds before sending to API
  if (valveOpenTime) updateData.ValveOpenTime = parseFloat(valveOpenTime) * 1000
  if (measurementInterval) updateData.MeasurementInterval = parseInt(measurementInterval) * 1000
  if (selectedCalibrationId !== undefined) updateData.calibrationId = selectedCalibrationId

    // Apply updates to all selected pairings
    const updatePromises = multiEditPairingsModalArgs?.pairingKeys.map(key => {
      return updatePairing(key.sensorId, key.valveId, updateData)
    }) || []

    try {
      // Wait for all updates to complete
      await Promise.all(updatePromises)

      // Refresh the pairings data
      mutatePairings()

      // Call the onSave callback with the number of updated pairings
      if (multiEditPairingsModalArgs?.onSave) {
        multiEditPairingsModalArgs.onSave(updatePromises.length)
      }

      handleCloseModal()
    } catch (error) {
      console.error('Error updating pairings:', error)
    } finally {
      setIsSaving(false)
    }
  }

  // Enhanced onChange handlers with validation
  const handleWtcPercentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setWtcPercentLimit(value);

    if (value) {
      const numValue = parseInt(value);
      if (numValue < 1 || numValue > 99) {
        setValidationErrors(prev => ({
          ...prev,
          wtcPercentLimit: 'VWC Percent must be between 1 and 99'
        }));
      } else {
        setValidationErrors(prev => {
          const newErrors = { ...prev };
          delete newErrors.wtcPercentLimit;
          return newErrors;
        });
      }
    } else {
      // If field is empty, remove error (as it's optional)
      setValidationErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors.wtcPercentLimit;
        return newErrors;
      });
    }
  };

  const handleValveOpenTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setValveOpenTime(value);

    if (value) {
      const numValue = parseFloat(value);
      if (numValue < 0 || numValue > 15) {
        setValidationErrors(prev => ({
          ...prev,
          valveOpenTime: 'Valve Open Time must be between 0 and 15 seconds'
        }));
      } else {
        setValidationErrors(prev => {
          const newErrors = { ...prev };
          delete newErrors.valveOpenTime;
          return newErrors;
        });
      }
    } else {
      // If field is empty, remove error (as it's optional)
      setValidationErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors.valveOpenTime;
        return newErrors;
      });
    }
  };

  const handleMeasurementIntervalChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setMeasurementInterval(value);

    if (value) {
      const numValue = parseInt(value);
      if (numValue < 1) {
        setValidationErrors(prev => ({
          ...prev,
          measurementInterval: 'Measurement Interval must be 1 or greater'
        }));
      } else {
        setValidationErrors(prev => {
          const newErrors = { ...prev };
          delete newErrors.measurementInterval;
          return newErrors;
        });
      }
    } else {
      // If field is empty, remove error (as it's optional)
      setValidationErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors.measurementInterval;
        return newErrors;
      });
    }
  };

  const handleMultiOperateValves = async (operation: ValveAction ) => {
    if (!multiEditPairingsModalArgs?.pairingKeys || multiEditPairingsModalArgs.pairingKeys.length === 0) {
      return;
    }

    try {
      setIsOperatingValves(true);

      // Get the valves from the pairingKeys
      const valvePromises = multiEditPairingsModalArgs.pairingKeys.map(async (key) => {
        // Find the valve using the valveId
        const valve = connectedDevices?.valves?.find((v: Valve) => v.id === key.valveId);

        if (!valve) {
          console.error(`Valve with ID ${key.valveId} not found`);
          return;
        }

        try {
          // Operate the valve
          await operateValve(valve.address, valve.relayAddress, operation);
        } catch (error) {
          console.error(`Error operating THIS valve ${valve.id}:`, error);
        }
      });

      await Promise.all(valvePromises.filter(Boolean));
    } catch (error) {
      console.error('Error operating valves:', error);
    } finally {
      setIsOperatingValves(false);
    }
  };

  // Check if we have any validation errors
  const hasValidationErrors = Object.keys(validationErrors).length > 0;

  // Format the polynomial function for the selected calibration
  const selectedCalibration = calibrations?.find(cal => cal.id === selectedCalibrationId);
  const polynomialFunction = selectedCalibration
    ? formatPolynomialFunction(selectedCalibration.polynomialCoefficientsCommaDelimited)
    : null;

  // // Add handleSetCalibration function
  // const handleSetCalibration = async (calibrationId: number | undefined) => {
  //   // Don't attempt to update if there are no pairings or if the system is locked
  //   if (!multiEditPairingsModalArgs?.pairingKeys || multiEditPairingsModalArgs.pairingKeys.length === 0 || lockedStatus) {
  //     return;
  //   }

  //   // Set state immediately for responsive UI
  //   setSelectedCalibrationId(calibrationId);

  //   try {
  //     setIsSaving(true);

  //     // Apply updates to all selected pairings
  //     const updatePromises = multiEditPairingsModalArgs.pairingKeys.map(key => {
  //       return setCalibrationId(key.sensorId, key.valveId, calibrationId);
  //     });

  //     // Wait for all updates to complete
  //     await Promise.all(updatePromises);

  //     // Refresh the pairings data
  //     mutatePairings();

  //     // Call the onSave callback with the number of updated pairings
  //     if (multiEditPairingsModalArgs.onSave) {
  //       multiEditPairingsModalArgs.onSave(updatePromises.length);
  //     }
  //   } catch (error) {
  //     console.error('Error updating calibrations:', error);
  //     // Optionally show an error notification here
  //   } finally {
  //     setIsSaving(false);
  //   }
  // };

  return (
    <Modal
      isOpen={multiEditPairingsModalIsShowing}
      closeModal={handleCloseModal}
      maxWidth="lg"
      closeButtonText={null}
    >
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold">Multi-Edit Pairings</h2>
          <p className="text-sm text-gray-500">
            Updating settings for {pairingCount} pairing{pairingCount !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Optional Fields Section */}
        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <h3 className="text-md font-semibold mb-3">Edit Settings</h3>
          <p className="text-sm text-gray-500 mb-4">
            Leave any field blank to keep its current value for each pairing.
          </p>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Group ID</label>
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              >
                <option value="">Select a group (optional)</option>
                {groups?.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">VWC Percent Limit</label>
              <input
                type="number"
                min="1"
                max="99"
                step="1"
                value={wtcPercentLimit}
                onChange={handleWtcPercentChange}
                className={`mt-1 block w-full rounded-md ${validationErrors.wtcPercentLimit ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                placeholder="1-99% (leave blank to keep current)"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Valve Open Time (seconds)</label>
              <input
                type="number"
                min="0"
                max="3600"
                step="1"
                value={valveOpenTime ? parseFloat(valveOpenTime) : ''}
                onChange={handleValveOpenTimeChange}
                className={`mt-1 block w-full rounded-md ${validationErrors.valveOpenTime ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                placeholder="In seconds (leave blank to keep current)"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Measurement Interval (seconds)</label>
              <input
                type="number"
                min="1"
                step="1"
                value={measurementInterval ? parseInt(measurementInterval) : ''}
                onChange={handleMeasurementIntervalChange}
                className={`mt-1 block w-full rounded-md ${validationErrors.measurementInterval ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                placeholder="In seconds (leave blank to keep current)"
              />
            </div>
          </div>
        </div>

        {/* Validation Errors Section - only shown when there are errors */}
        {hasValidationErrors && (
          <div className="p-4 bg-red-50 rounded-lg border border-red-200">
            <h3 className="text-md font-semibold mb-2 text-red-700">Please fix the following issues:</h3>
            <ul className="list-disc pl-5 space-y-1 text-red-600">
              {Object.entries(validationErrors).map(([field, message]) => (
                <li key={field}>{message}</li>
              ))}
            </ul>
          </div>
        )}

        {lockedStatus && (
          <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
            <h3 className="text-md font-semibold mb-2 text-yellow-700">The system is locked. Pairings cannot be edited or deleted.</h3>
          </div>
        )}

                {/* Calibration Section */}
                <div className="p-4 bg-white rounded-lg border border-gray-200 mb-4">
          <h3 className="text-md font-semibold mb-3">Calibration</h3>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">
              Select Calibration
            </label>
            <select
              value={selectedCalibrationId?.toString() || ''}
              onChange={(e) => setSelectedCalibrationId(e.target.value ? parseInt(e.target.value) : undefined)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              disabled={lockedStatus || isSaving}
            >
              <option value="">No calibration selected</option>
              {isCalibrationLoading ? (
                <option disabled>Loading calibrations...</option>
              ) : (
                calibrations?.map((cal) => (
                  <option key={cal.id} value={cal.id}>
                    {cal.name}
                  </option>
                ))
              )}
            </select>
          </div>

          {selectedCalibration && (
            <div className="mt-4 p-3 bg-gray-50 rounded-md">
              <h4 className="text-sm font-medium mb-2">Calibration Function</h4>
              <p className="text-sm font-mono">{polynomialFunction}</p>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-2">Calibrations determine how sensor readings are converted to water content values.</p>

          {isSaving && (
            <div className="mt-2 flex items-center justify-center">
              <SpinningLoader svgClassName="w-5 h-5" />
              <span className="ml-2 text-sm text-gray-600">Applying calibration to {pairingCount} pairs...</span>
            </div>
          )}
        </div>

        {/* Manual Controls Section */}
        <div className="p-4 bg-white rounded-lg border border-gray-200 relative">
          <div className={`${!manualControlsUnlocked ? 'absolute inset-0 bg-gray-200 bg-opacity-70 backdrop-blur-sm flex items-center justify-center z-10 rounded-lg' : 'hidden'}`}>
            <div className="text-center p-4">
              <button
                onClick={() => setManualControlsUnlocked(true)}
                className="px-4 py-2 text-sm font-medium text-white bg-orange-600 rounded hover:bg-orange-700 mb-2"
              >
                Unlock Manual Controls
              </button>
              <p className="text-xs text-gray-700">Manual operations may interrupt automations</p>
            </div>
          </div>

          <h3 className="text-md font-semibold mb-3">Manual Controls</h3>

          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-gray-50 rounded-md">
              <h4 className="text-sm font-medium mb-2">Valve Control ({pairingCount} valves)</h4>
              <div className="flex items-center space-x-3">
                <button
                  onClick={() => handleMultiOperateValves(ValveAction.OPEN)}
                  disabled={isOperatingValves || !manualControlsUnlocked || lockedStatus}
                  className="w-full px-3 py-1 text-sm font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:bg-green-300 disabled:cursor-not-allowed"
                >
                  {isOperatingValves ? <SpinningLoader svgClassName="w-4 h-4" /> : 'Open All Valves'}
                </button>
                <button
                  onClick={() => handleMultiOperateValves(ValveAction.CLOSE)}
                  disabled={isOperatingValves || !manualControlsUnlocked || lockedStatus}
                  className="w-full px-3 py-1 text-sm font-medium text-white bg-red-600 rounded hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed"
                >
                  {isOperatingValves ? <SpinningLoader svgClassName="w-4 h-4" /> : 'Close All Valves'}
                </button>
              </div>
            </div>

            <div className="p-3 bg-gray-50 rounded-md">
              <h4 className="text-sm font-medium mb-2">Sensor Direct Reading</h4>
              <div className="flex items-center space-x-3">
                <p className="text-sm italic text-gray-500">Direct sensor reading for multiple sensors coming soon</p>
              </div>
            </div>
          </div>

          <p className="text-xs text-gray-500 mt-4">Warning: Manual controls bypass automation systems and may interfere with scheduled operations.</p>
        </div>



        <div className="flex justify-end space-x-3 pt-2">
          <button
            onClick={() => handleCloseModal()}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
            disabled={isSaving}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed"
            disabled={
              (!groupId && !wtcPercentLimit && !valveOpenTime && !measurementInterval && !selectedCalibrationId) ||
              hasValidationErrors ||
              lockedStatus
            }
          >
            {isSaving ? <SpinningLoader svgClassName="w-4 h-4" /> : 'Apply Changes'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export const MultiEditPairingsModalProvider = ({ children }: { children: ReactNode }) => {
  const [isShowing, setIsShowing] = useState(false)
  const [modalArgs, setModalArgs] = useState<MultiEditPairingsModalArgs | null>(null)

  return (
    <ModalIsShowingContext.Provider value={isShowing}>
      <SetModalIsShowingContext.Provider value={setIsShowing}>
        <ModalArgsContext.Provider value={modalArgs}>
          <SetModalArgsContext.Provider value={setModalArgs}>
            <CustomizedModal />
            {children}
          </SetModalArgsContext.Provider>
        </ModalArgsContext.Provider>
      </SetModalIsShowingContext.Provider>
    </ModalIsShowingContext.Provider>
  )
}

export const useMultiEditPairingsModal = () => {
  const multiEditPairingsModalArgs = useContext(ModalArgsContext)
  const setMultiEditPairingsModalArgs = useContext(SetModalArgsContext)
  const setIsShowing = useContext(SetModalIsShowingContext)
  const multiEditPairingsModalIsShowing = useContext(ModalIsShowingContext)

  const showMultiEditPairingsModal = useCallback((input: MultiEditPairingsModalArgs | null) => {
    setMultiEditPairingsModalArgs(input)
    setIsShowing(true)
  }, [setMultiEditPairingsModalArgs, setIsShowing])

  const hideMultiEditPairingsModal = useCallback(() => {
    setIsShowing(false)
  }, [setIsShowing])

  return {
    multiEditPairingsModalArgs,
    hideMultiEditPairingsModal,
    showMultiEditPairingsModal,
    multiEditPairingsModalIsShowing
  }
}
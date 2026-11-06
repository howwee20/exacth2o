'use client'

import { Dispatch, ReactNode, SetStateAction, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import Modal from "./Modal"
import { createPairing, deletePairing, updatePairing } from "../server-actions/pairingsCRUD"
import { Pairing, Sensor, Valve, ValveAction } from "../lib/types"
import { useConnectedDevices } from "../swr/useConnectedDevices"
import { usePairings } from "../swr/usePairings"
import { useGroups } from "../swr/useGroups"
import { useGenericModal } from "./GenericModal"
import { SpinningLoader } from "./SpinningLoader"
import { useSystem } from "../swr/useLockedStatus"
import { getSensorDirectReading } from "../server-actions/sensorOperations"
import { operateValve } from "../server-actions/valveOperations"
import { useCalibrations, formatPolynomialFunction } from "../swr/useCalibrations"

export interface PairingsModalArgs {
  onSave?: (pairing: Pairing) => void
  onCloseCallback?: () => void
  existingPairing?: Pairing  // Add optional existingPairing for edit mode
}

const VALVE_OPEN_TIME_MAX_SECONDS = 60*60*24; // Maximum allowed valve open time in seconds

// Create contexts for modal state management
const ModalIsShowingContext = createContext(false)
const SetModalIsShowingContext = createContext<Dispatch<SetStateAction<boolean>>>(() => {})
const ModalArgsContext = createContext<PairingsModalArgs | null>(null)
const SetModalArgsContext = createContext<Dispatch<SetStateAction<PairingsModalArgs | null>>>(() => {})

const CustomizedModal = () => {
  const [pairingName, setPairingName] = useState("")
  const [selectedSensorId, setSelectedSensorId] = useState<number | undefined>(undefined)
  const [selectedValveId, setSelectedValveId] = useState<number | undefined>(undefined)
  const [groupId, setGroupId] = useState("")
  const [wtcPercentLimit, setWtcPercentLimit] = useState("")
  const [valveOpenTime, setValveOpenTime] = useState("")
  const [measurementInterval, setMeasurementInterval] = useState("")
  const [selectedCalibrationId, setSelectedCalibrationId] = useState<number | undefined>(undefined)
  const [manualControlsUnlocked, setManualControlsUnlocked] = useState(false)
  const [sensorReadingValue, setSensorReadingValue] = useState<number | null>(null)
  const [isGettingReading, setIsGettingReading] = useState(false)
  const [isOperatingValve, setIsOperatingValve] = useState(false)

  const { showGenericModal } = useGenericModal()
  const { calibrations, isLoading: isCalibrationLoading } = useCalibrations()

  // Track if we're in edit mode
  const [isEditMode, setIsEditMode] = useState(false)

  // Validation error states
  const [validationErrors, setValidationErrors] = useState<{
    wtcPercentLimit?: string;
    valveOpenTime?: string;
    measurementInterval?: string;
  }>({})

  const { connectedDevices } = useConnectedDevices()
  const { pairings, isLoading: isPairingsLoading } = usePairings()
  const { lockedStatus } = useSystem()
  const { mutate: mutatePairings } = usePairings()
  const { groups } = useGroups()

  const {
    hidePairingsModal,
    pairingsModalArgs,
    pairingsModalIsShowing,
    showPairingsModal
  } = usePairingsModal()

  const unPairedDevices: {sensors: Sensor[], valves: Valve[]} = useMemo(() => {
    // In edit mode, we need to include the existing paired sensor/valve in the options
    const existingSensorId = pairingsModalArgs?.existingPairing?.sensorId;
    const existingValveId = pairingsModalArgs?.existingPairing?.valveId;

    return {
      sensors: connectedDevices?.sensors?.filter(sensor =>
        !pairings?.some(pairing => pairing.sensorId === sensor.id) ||
        sensor.id === existingSensorId) || [],
      valves: connectedDevices?.valves?.filter(valve =>
        !pairings?.some(pairing => pairing.valveId === valve.id) ||
        valve.id === existingValveId) || []
    }
  }, [connectedDevices, pairings, pairingsModalArgs])

  const preventEditing: boolean | undefined = isPairingsLoading || lockedStatus

  // Set initial values when modal opens with existingPairing
  useEffect(() => {
    if (pairingsModalArgs?.existingPairing && pairingsModalIsShowing) {
      const pairing = pairingsModalArgs.existingPairing;
      setPairingName(pairing.name || "");
      setSelectedSensorId(pairing.sensorId);
      setSelectedValveId(pairing.valveId);
      setGroupId(pairing.groupId?.toString() || "");
      setWtcPercentLimit(pairing.WTCPercentLimit?.toString() || "");
      // Convert milliseconds back to seconds for display
      setValveOpenTime(pairing.ValveOpenTime ? (pairing.ValveOpenTime / 1000).toString() : "");
      setMeasurementInterval(pairing.MeasurementInterval ? (pairing.MeasurementInterval / 1000).toString() : "");
      setSelectedCalibrationId(pairing.calibrationId);
      setIsEditMode(true);
    } else if (pairingsModalIsShowing) {
      // Reset in create mode
      setIsEditMode(false);
    }
  }, [pairingsModalArgs, pairingsModalIsShowing]);

  // Reset manual controls lock when modal closes or opens
  useEffect(() => {
    if (!pairingsModalIsShowing) {
      setManualControlsUnlocked(false)
      setSensorReadingValue(null)
    }
  }, [pairingsModalIsShowing]);

  const handleCloseModal = () => {
    setPairingName("") // Reset id to a new UUID
    setSelectedSensorId(undefined) // Reset selections
    setSelectedValveId(undefined)
    setGroupId("")
    setWtcPercentLimit("")
    setValveOpenTime("")
    setMeasurementInterval("")
    setSelectedCalibrationId(undefined)
    setValidationErrors({}) // Clear validation errors
    setIsEditMode(false) // Reset edit mode
    hidePairingsModal()
    if(pairingsModalArgs?.onCloseCallback) {
      pairingsModalArgs.onCloseCallback()
    }
  }

  const handleSave = async (sensorId?: number, valveId?: number, pairingName?: string) => {
    if(!sensorId || !valveId || !pairingName) {
      console.error('All fields must be set')
      return
    }

    // Don't allow save if there are validation errors
    if (Object.keys(validationErrors).length > 0) {
      return
    }


    // Prepare pairing data object
    const pairingData = {
      name: pairingName,
      groupId: groupId ? parseInt(groupId) : undefined,
      WTCPercentLimit: wtcPercentLimit ? parseInt(wtcPercentLimit) : undefined,
      ValveOpenTime: valveOpenTime ? parseFloat(valveOpenTime) * 1000 : undefined, // Convert seconds to milliseconds
      MeasurementInterval: measurementInterval ? parseInt(measurementInterval) * 1000 : undefined, // Convert seconds to milliseconds
      calibrationId: selectedCalibrationId
    };

    let result;
    if (isEditMode) {
      // In edit mode, update the existing pairing

      // but first, make sure the system isn't locked
      if(lockedStatus) {
        console.error('System is locked')
        return
      }

      // Note: For updating, we don't include sensorId and valveId in the data as they're in the URL
      result = await updatePairing(
        sensorId,
        valveId,
        pairingData
      );
    } else {
      // In create mode, create a new pairing
      // For creating, we need to include sensorId and valveId in the payload
      result = await createPairing({
        ...pairingData,
        sensorId: sensorId,
        valveId: valveId,
      });
    }

    // refetch the pairings swr
    mutatePairings()

    if (pairingsModalArgs?.onSave) {
      pairingsModalArgs.onSave(result)
    }
    handleCloseModal()
  }

  const handleDelete = async (sensorId?: number, valveId?: number, pairingName?: string) => {
    if(!sensorId || !valveId || !pairingName) {
      console.error('handleDelete | sensorId or valveId or pairingName is not set')
      return
    }
    const sensorName = connectedDevices?.sensors?.find(sensor => sensor.id === sensorId)?.name
    const valveAddress = connectedDevices?.valves?.find(valve => valve.id === valveId)?.address
    showGenericModal({
      mainText: 'Are you sure you want to delete ' + pairingName + '?',
      confirmButtonText: 'Delete',
      cancelButtonText: 'Cancel',
      subText: <span>{sensorName} and Valve at {valveAddress}.<br /><strong>This action cannot be undone.</strong></span>,
      onConfirmCallback: async () => {
        await deletePairing(sensorId, valveId)
        mutatePairings()
      },
      onCancelCallback: () => {
        showPairingsModal(pairingsModalArgs)
      }
    })
    handleCloseModal()
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
          wtcPercentLimit: 'WTC Percent must be between 1 and 99'
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
      if (numValue < 0 || numValue > VALVE_OPEN_TIME_MAX_SECONDS) {
        setValidationErrors(prev => ({
          ...prev,
          valveOpenTime: `Valve Open Time must be between 0 and ${VALVE_OPEN_TIME_MAX_SECONDS} seconds`
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

  const handleGetSensorReading = async () => {
    if (!pairingsModalArgs?.existingPairing) return;

    try {
      setIsGettingReading(true);
      const sensorId = pairingsModalArgs.existingPairing.sensorId;
      const result = await getSensorDirectReading(sensorId);
      console.log('Sensor reading result:', JSON.stringify(result, null, 2));
      const readingData = result?.value?.data[0];
      if (!readingData) {
        console.error('Invalid getSensorDirectReading data:', result);
        return;
      }
      if (typeof readingData.volumetricWaterContent !== 'number') {
        console.error('Invalid getSensorDirectReading value:', result);
        return;
      }
      setSensorReadingValue(readingData.volumetricWaterContent);
    } catch (error) {
      console.error('Error getting sensor reading:', error);
    } finally {
      setIsGettingReading(false);
    }
  };

  const handleOperateValve = async (operation: ValveAction) => {
    if (!pairingsModalArgs?.existingPairing) return;

    try {
      setIsOperatingValve(true);
      const valve = connectedDevices?.valves?.find(
        v => v.id === pairingsModalArgs.existingPairing?.valveId
      );

      if (!valve) {
        throw new Error('Valve not found');
      }

      await operateValve(valve.address, valve.relayAddress, operation);
    } catch (error) {
      console.error('Error operating valve:', error);
    } finally {
      setIsOperatingValve(false);
    }
  };

  // Check if we have any validation errors
  const hasValidationErrors = Object.keys(validationErrors).length > 0;

  // Get the selected calibration
  const selectedCalibration = useMemo(() => {
    if (!selectedCalibrationId || !calibrations) return null;
    return calibrations.find(cal => cal.id === selectedCalibrationId);
  }, [selectedCalibrationId, calibrations]);

  // Format the polynomial function
  const polynomialFunction = useMemo(() => {
    if (!selectedCalibration) return null;
    return formatPolynomialFunction(selectedCalibration.polynomialCoefficientsCommaDelimited);
  }, [selectedCalibration]);

  // // Add handleSetCalibration function
  // const handleSetCalibration = async (calibrationId: number | undefined) => {
  //   // Don't attempt to update if we don't have a pairing or if the system is locked
  //   if (!pairingsModalArgs?.existingPairing || preventEditing) {
  //     return;
  //   }

  //   // Set state immediately for responsive UI
  //   setSelectedCalibrationId(calibrationId);

  //   try {
  //     // Only make the API call if we're in edit mode with an existing pairing
  //     if (isEditMode && pairingsModalArgs.existingPairing) {
  //       const { sensorId, valveId } = pairingsModalArgs.existingPairing;
  //       await setCalibrationId(sensorId, valveId, calibrationId);

  //       // Refresh data
  //       mutatePairings();
  //     }
  //   } catch (error) {
  //     console.error('Error updating calibration:', error);
  //     // Optionally show an error notification here
  //   }
  // };

  return (
    <Modal
      isOpen={pairingsModalIsShowing}
      closeModal={handleCloseModal}
      maxWidth="xl"
      closeButtonText={null}
    >
      {isPairingsLoading ? (
        <div className="flex justify-center items-center h-96">
          <SpinningLoader svgClassName="w-8 h-8" />
        </div>
      ) : (
      <div className="space-y-6 overflow-y-scroll max-h-[80vh]">
        <div>
          <h2 className="text-xl font-bold">{isEditMode ? "Update" : "Create New"} Sensor-Valve Pairing</h2>
          <p className="text-sm text-gray-500">{isEditMode ? "Update an existing" : "Configure a new"} pairing between a sensor and valve</p>
        </div>

        {/* Required Fields Section */}
        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <h3 className="text-md font-semibold mb-3">Required Information</h3>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700">Name</label>
            <input
              type="text"
              value={pairingName}
              onChange={(e) => setPairingName(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              placeholder="Enter pairing name"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Sensor</label>
              <select
                value={selectedSensorId}
                onChange={(e) => setSelectedSensorId(parseInt(e.target.value))}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                disabled={isEditMode} // Disable in edit mode as it's part of the primary key
              >
                <option value="">Select a sensor</option>
                {unPairedDevices?.sensors?.map((sensor) => (
                  <option key={sensor.id} value={sensor.id}>
                    {sensor.name}) {sensor.boardSerialId}:{sensor.address}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Valve</label>
              <select
                value={selectedValveId}
                onChange={(e) => setSelectedValveId(parseInt(e.target.value))}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                disabled={isEditMode} // Disable in edit mode as it's part of the primary key
              >
                <option value="">Select a valve</option>
                {unPairedDevices?.valves?.map((valve) => (
                  <option key={valve.id} value={valve.id}>
                    {valve.id}) {valve.relayAddress}:{valve.address}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Optional Fields Section */}
        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <h3 className="text-md font-semibold mb-3">Optional Settings</h3>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Group ID</label>
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                disabled={preventEditing}
              >
                <option value="">Select a group (optional)</option>
                {groups?.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.type.charAt(0).toUpperCase() + group.type.slice(1)} {group.name}
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
                placeholder="1-99% (optional)"
                disabled={preventEditing}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Valve Open Time (seconds)</label>
              <input
                type="number"
                min="0"
                max="15"
                step="1"
                value={valveOpenTime}
                onChange={handleValveOpenTimeChange}
                className={`mt-1 block w-full rounded-md ${validationErrors.valveOpenTime ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                placeholder="0-15 seconds (optional)"
                disabled={preventEditing}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Measurement Interval (seconds)</label>
              <input
                type="number"
                min="1"
                step="1"
                value={measurementInterval}
                onChange={handleMeasurementIntervalChange}
                className={`mt-1 block w-full rounded-md ${validationErrors.measurementInterval ? 'border-red-500' : 'border-gray-300'} shadow-sm focus:border-blue-500 focus:ring-blue-500`}
                placeholder="In seconds (optional)"
                disabled={preventEditing}
              />
            </div>
          </div>
        </div>

          {/* Calibration Section - Only shown in edit mode */}
          {pairingsModalArgs?.existingPairing && (
          <div className="p-4 bg-white rounded-lg border border-gray-200">
            <h3 className="text-md font-semibold mb-3">Calibration</h3>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700">
                Select Calibration
              </label>
              <select
                value={selectedCalibrationId?.toString() || ''}
                onChange={(e) => setSelectedCalibrationId(e.target.value ? parseInt(e.target.value) : undefined)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                disabled={preventEditing}
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
          </div>
        )}

        {/* Manual Controls Section - Only shown in edit mode */}
        {pairingsModalArgs?.existingPairing && (
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
                <h4 className="text-sm font-medium mb-2">Valve Control</h4>
                <div className="flex items-center space-x-3">
                  <button
                    onClick={() => handleOperateValve(ValveAction.OPEN)}
                    disabled={isOperatingValve || !manualControlsUnlocked}
                    className="w-full h-12 px-3 py-1 text-sm font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:bg-green-300 disabled:cursor-not-allowed"
                  >
                    {isOperatingValve ? <SpinningLoader svgClassName="w-4 h-4" /> : 'Open Valve'}
                  </button>
                  <button
                    onClick={() => handleOperateValve(ValveAction.CLOSE)}
                    disabled={isOperatingValve || !manualControlsUnlocked}
                    className="w-full h-12 px-3 py-1 text-sm font-medium text-white bg-red-600 rounded hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed"
                  >
                    {isOperatingValve ? <SpinningLoader svgClassName="w-4 h-4" /> : 'Close Valve'}
                  </button>
                </div>
              </div>

              <div className="p-3 bg-gray-50 rounded-md">
                <h4 className="text-sm font-medium mb-2">Sensor Direct Reading</h4>
                <div className="flex items-center space-x-3">
                  <button
                    onClick={handleGetSensorReading}
                    disabled={isGettingReading || !manualControlsUnlocked}
                    className="px-3 py-1 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed"
                  >
                    {isGettingReading ? <SpinningLoader svgClassName="w-4 h-4" /> : 'Get Reading'}
                  </button>
                  {sensorReadingValue !== null && (
                    <div className="text-lg font-semibold">{sensorReadingValue}</div>
                  )}
                </div>
              </div>
            </div>

            <p className="text-xs text-gray-500 mt-4">Warning: Manual controls bypass automation systems and may interfere with scheduled operations.</p>
          </div>
        )}



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

        {preventEditing && (
          <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-200">
            <h3 className="text-md font-semibold mb-2 text-yellow-700">The system is currently locked. This pairing cannot be edited or deleted.</h3>
          </div>
        )}

        <div className="flex justify-between">
          {pairingsModalArgs?.existingPairing && (
            <div className="flex justify-end space-x-3 pt-2">
              <button
                onClick={() => handleDelete(pairingsModalArgs.existingPairing?.sensorId, pairingsModalArgs.existingPairing?.valveId, pairingsModalArgs.existingPairing?.name)}
                className="px-4 py-2 text-sm font-medium text-red-600 bg-gray-100 hover:text-white hover:bg-red-600 rounded disabled:bg-gray-200 disabled:cursor-not-allowed disabled:text-red-400"
                disabled={preventEditing}
              >
                Delete
              </button>
            </div>
          )}
          <div className="flex justify-end space-x-3 pt-2">
            <button
              onClick={() => handleCloseModal()}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={() => handleSave(selectedSensorId, selectedValveId, pairingName)}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed"
              disabled={!selectedSensorId || !selectedValveId || !pairingName || hasValidationErrors || preventEditing}
            >
              {isEditMode ? "Update" : "Save"} Pairing
            </button>
          </div>
        </div>
        </div>
      )}
    </Modal>
  )
}

export const PairingsModalProvider = ({ children }: { children: ReactNode }) => {
  const [isShowing, setIsShowing] = useState(false)
  const [modalArgs, setModalArgs] = useState<PairingsModalArgs | null>(null)

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

export const usePairingsModal = () => {
  const pairingsModalArgs = useContext(ModalArgsContext)
  const setPairingsModalArgs = useContext(SetModalArgsContext)
  const setIsShowing = useContext(SetModalIsShowingContext)
  const pairingsModalIsShowing = useContext(ModalIsShowingContext)

  const showPairingsModal = useCallback((input: PairingsModalArgs | null) => {
    setPairingsModalArgs(input)
    setIsShowing(true)
  }, [setPairingsModalArgs, setIsShowing])

  const hidePairingsModal = useCallback(() => {
    setIsShowing(false)
  }, [setIsShowing])

  return {
    pairingsModalArgs,
    hidePairingsModal,
    showPairingsModal,
    pairingsModalIsShowing
  }
}

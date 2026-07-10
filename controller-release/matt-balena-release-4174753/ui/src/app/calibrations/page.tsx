'use client'

import { useState, useEffect, useRef } from 'react'
import { Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Scatter, ComposedChart } from 'recharts'
import { ArrowDownCircleIcon, TrashIcon } from '@heroicons/react/24/outline'
import { useConnectedDevices } from '../swr/useConnectedDevices'
import { useCalibrations, formatPolynomialFunction } from '../swr/useCalibrations'
import ProtectedLayout from '../ProtectedLayout'
import { SpinningLoader } from '../lib/SpinningLoader'
import { evaluatePolynomial, findBestFitPolynomial } from './math'
import { checkCalibrationNameExists, createCalibration, deleteCalibration } from '../server-actions/calibrationsCRUD'
import { usePolynomialModal } from '../lib/PolynomialModal'
import { getSensorDirectReading } from '../server-actions/sensorOperations'
import { useRouter } from 'next/navigation'


// Calculate R-squared value (coefficient of determination)
const calculateRSquared = (points: {x: number, y: number}[], coefficients: number[]): number => {
  if (points.length < 2) return 0;

  // Calculate mean of y values
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / points.length;

  // Calculate total sum of squares
  const totalSumSquares = points.reduce((sum, point) => sum + Math.pow(point.y - yMean, 2), 0);

  // Calculate residual sum of squares
  const residualSumSquares = points.reduce((sum, point) => {
    const predicted = evaluatePolynomial(coefficients, point.x);
    return sum + Math.pow(point.y - predicted, 2);
  }, 0);

  // Calculate R-squared
  return 1 - (residualSumSquares / totalSumSquares);
}

// Format polynomial equation as a string
const formatPolynomialEquation = (coefficients: number[]): string => {
  if (!coefficients || coefficients.length === 0) return '';

  return coefficients.map((coeff, index) => {
    if (Math.abs(coeff) < 1e-10) return null; // Skip terms with zero coefficients

    const formattedCoeff = Math.abs(coeff) < 0.01 ?
      coeff.toExponential(2) :
      coeff.toFixed(4);

    let term = '';

    // First term is just the constant
    if (index === 0) {
      term = formattedCoeff;
    }
    // x term
    else if (index === 1) {
      term = `${formattedCoeff}x`;
    }
    // Higher power terms
    else {
      term = `${formattedCoeff}x^${index}`;
    }

    // Add plus sign if it's not the first term and coefficient is positive
    if (index > 0 && coeff >= 0) {
      term = ' + ' + term;
    }
    // Add minus sign if coefficient is negative
    else if (coeff < 0) {
      term = ' - ' + term.substring(1); // Remove the negative sign since we're using a minus
    }

    return term;
  }).filter(Boolean).join('');
}

export default function CalibrationPage() {
  const { connectedDevices, isLoading: connectedDevicesLoading } = useConnectedDevices()
  const { calibrations, isLoading: calibrationsLoading, mutate: mutateCalibrations } = useCalibrations()
  const [calibrationFileName, setCalibrationFileName] = useState('')
  const [calibrationValues, setCalibrationValues] = useState<number[]>([10, 20, 40, 50, 70, 80])
  const [selectedSensors, setSelectedSensors] = useState<number[]>([])
  const [sensorValues, setSensorValues] = useState<Record<number, number[]>>({})
  const [averageReadings, setAverageReadings] = useState<number[]>([])
  const [fetchingReading, setFetchingReading] = useState<{sensorId: number, rowIndex: number} | null>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)

  // Polynomial fitting state
  const [polynomialCoefficients, setPolynomialCoefficients] = useState<number[]>([])
  const [curvePoints, setCurvePoints] = useState<{vwc: number, average: number}[]>([])
  const [rSquared, setRSquared] = useState<number | null>(null)
  const [showCurve, setShowCurve] = useState(false)
  const [polynomialDegree, setPolynomialDegree] = useState<number | 'manual' | undefined>(undefined) // Default to linear

  // UI state
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [nameExists, setNameExists] = useState(false)
  const [isCheckingName, setIsCheckingName] = useState(false)

  const router = useRouter()


  // Polynomial modal hook
  const { showPolynomialModal } = usePolynomialModal()

  // Check if name exists with debounce
  useEffect(() => {
    if (!calibrationFileName.trim()) {
      setNameExists(false)
      setErrorMessage(null)
      return
    }

    const timer = setTimeout(async () => {
      setIsCheckingName(true)
      try {
        const exists = await checkCalibrationNameExists(calibrationFileName)
        setNameExists(exists)
        if (exists) {
          setErrorMessage('A calibration with this name already exists')
        } else {
          setErrorMessage(null)
        }
      } catch (error) {
        console.error('Error checking name:', error)
      } finally {
        setIsCheckingName(false)
      }
    }, 500) // Debounce for 500ms

    return () => clearTimeout(timer)
  }, [calibrationFileName])


  // Initialize sensorValues when selectedSensors changes
  useEffect(() => {
    const newSensorValues: Record<number, number[]> = {}

    selectedSensors.forEach(sensorId => {
      // Initialize with zeros
      newSensorValues[sensorId] = Array(calibrationValues.length).fill(0)
    })

    setSensorValues(newSensorValues)
  }, [selectedSensors])

  // Calculate average readings based on selected sensors and their values
  const calculateAverages = (selectedIds: number[]) => {
    const averages = calibrationValues.map((_, index) => {
      let sum = 0
      let count = 0

      selectedIds.forEach(sensorId => {
        const value = sensorValues[sensorId]?.[index]

        if (value !== undefined) {
          sum += value
          count++
        }
      })

      return count > 0 ? parseFloat((sum / count).toFixed(2)) : 0
    })

    setAverageReadings(averages)
  }

  // Recalculate averages when sensorValues change
  useEffect(() => {
    calculateAverages(selectedSensors)
  }, [sensorValues])

  // Handle sensor selection change
  const handleSensorChange = (sensorId: number) => {
    // Check if sensor already selected
    if (selectedSensors.includes(sensorId)) {
      return; // Sensor already in selection
    }

    // Add sensor to selection
    const newSelection = [...selectedSensors, sensorId]
    setSelectedSensors(newSelection)
    calculateAverages(newSelection)
  }

  // Remove a sensor from selection
  const removeSensor = (sensorId: number) => {
    const newSelection = selectedSensors.filter(id => id !== sensorId)
    setSelectedSensors(newSelection)
    calculateAverages(newSelection)

    // Also remove this sensor from sensorValues
    const newSensorValues = {...sensorValues}
    delete newSensorValues[sensorId]
    setSensorValues(newSensorValues)
  }

  // Handle value change for VWC
  const handleValueChange = (index: number, value: string) => {
    const newValue = parseInt(value) || 0
    const newValues = [...calibrationValues]
    newValues[index] = newValue
    setCalibrationValues(newValues)
  }

  // Handle value change for sensor readings
  const handleSensorValueChange = (sensorId: number, rowIndex: number, value: string) => {
    const numValue = parseFloat(value) || 0

    setSensorValues(prev => {
      const newValues = {...prev}
      if (!newValues[sensorId]) {
        newValues[sensorId] = Array(calibrationValues.length).fill(0)
      }
      newValues[sensorId] = [...newValues[sensorId]]
      newValues[sensorId][rowIndex] = numValue
      return newValues
    })
  }

  // Fetch sensor reading
  const fetchSensorReading = async (sensorId: number, rowIndex: number) => {
    setFetchingReading({sensorId, rowIndex})

    try {
      // Get reading from sensor
      const results = (await getSensorDirectReading(sensorId, 1))
      let reading = null
      if (Array.isArray(results?.value.data) && results.value.data.length > 0) {
        reading = results.value.data[0]?.volumetricWaterContent
      } else {
        console.warn('No data available for sensor reading:', results?.value.data)
      }
      console.log('Fetched sensor reading:', reading)
      // Update the sensor value
      setSensorValues(prev => {
        const newValues = {...prev}
        if (!newValues[sensorId]) {
          newValues[sensorId] = Array(calibrationValues.length).fill(0)
        }
        newValues[sensorId] = [...newValues[sensorId]]
        newValues[sensorId][rowIndex] = reading
        return newValues
      })
    } catch (error) {
      console.error('Error fetching sensor reading:', error)
    } finally {
      setFetchingReading(null)
    }
  }

  // Generate chart data
  const chartData = calibrationValues.map((value, index) => ({
    vwc: value,
    average: averageReadings[index] || 0
  }))

  // Calculate polynomial fit
  const calculatePolynomialFit = (explicitDegree?: number) => {
    if (explicitDegree === undefined) {
      return
    }
    try {
      // First, ensure we have enough valid data points
      const validPoints = chartData.filter(point => point.average > 0)

      if (validPoints.length < 4) {
        alert('Need at least 4 valid data points for calibration')
        return
      }

      // Convert data to the format needed by our math functions
      const points = validPoints.map(point => ({
        x: point.average,
        y: point.vwc
      }))

      // Determine maximum degree based on points available
      const maxDegree = Math.min(5, points.length - 1)
      const degree = Math.min(explicitDegree, maxDegree)

      // Calculate best-fit polynomial coefficients
      const coefficients = findBestFitPolynomial(points, degree)
      setPolynomialCoefficients(coefficients)

      // Calculate R-squared value
      const rsquared = calculateRSquared(points, coefficients)
      setRSquared(rsquared)

      // Generate points for the curve
      // First, find min and max x values
      const xValues = points.map(p => p.x)
      const minX = Math.min(...xValues)
      const maxX = Math.max(...xValues)

      // Generate curve points for plotting
      const step = (maxX - minX) / 100 // More points for smoother curve
      const curve = []

      // Generate extra points before and after the data range for better visualization
      const padding = (maxX - minX) * 0.1 // Add 10% padding on each side

      for (let x = minX - padding; x <= maxX + padding; x += step) {
        const y = evaluatePolynomial(coefficients, x)
        if (y >= 0) { // Only include positive values for VWC
          curve.push({
            average: x,
            vwc: y
          })
        }
      }

      // Debug logging
      // console.log('Polynomial Coefficients:', coefficients);
      // console.log('Curve Points:', curve);
      // console.log('R-Squared:', rsquared);

      setCurvePoints(curve)
      setShowCurve(true)
    } catch (error) {
      console.error('Error calculating polynomial fit:', error)
      alert(`Error calculating fit: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Set degree and calculate fit
  const setDegreeAndCalculate = (degree: number | 'manual') => {
    setPolynomialDegree(degree)
    if (typeof degree === 'number') {
      calculatePolynomialFit(degree)
    } else if (degree === 'manual') {
      showPolynomialModal({
        onConfirm: (coefficients) => {
          try {
            console.log('coefficients', coefficients)
            setPolynomialCoefficients(coefficients)

            // Generate points for the curve if we have valid data
            const validPoints = chartData.filter(point => point.average > 0)
            if (validPoints.length > 0) {
              const points = validPoints.map(point => ({
                x: point.average,
                y: point.vwc
              }))

              // Calculate R-squared value
              const rsquared = calculateRSquared(points, coefficients)
              setRSquared(rsquared)

              // Generate curve points for plotting
              const xValues = points.map(p => p.x)
              const minX = Math.min(...xValues)
              const maxX = Math.max(...xValues)

              const step = (maxX - minX) / 100
              const curve = []

              const padding = (maxX - minX) * 0.1

              for (let x = minX - padding; x <= maxX + padding; x += step) {
                const y = evaluatePolynomial(coefficients, x)
                if (y >= 0) {
                  curve.push({
                    average: x,
                    vwc: y
                  })
                }
              }

              setCurvePoints(curve)
              setShowCurve(true)
            }
          } catch (error) {
            console.error('Error calculating polynomial fit:', error)
          }
        }
      })
    }
  }

  // Format readings JSON for saving
  const formatReadingsJSON = (): Record<string, Record<string, number>> => {
    const result: Record<string, Record<string, number>> = {};

    selectedSensors.forEach(sensorId => {
      const sensorReadings: Record<string, number> = {};

      calibrationValues.forEach((vwc, index) => {
        const reading = sensorValues[sensorId]?.[index] || 0;
        sensorReadings[vwc.toString()] = reading;
      });

      result[sensorId.toString()] = sensorReadings;
    });

    return result;
  };

  // Handle saving the calibration
  const handleSaveCalibration = async () => {
    if (!calibrationFileName.trim()) {
      setErrorMessage('Please enter a calibration name');
      return;
    }

    if (nameExists) {
      setErrorMessage('A calibration with this name already exists');
      return;
    }

    if (polynomialCoefficients.length === 0) {
      setErrorMessage('Please calculate a polynomial fit first');
      return;
    }


    setIsSaving(true);
    setErrorMessage(null);

    try {
      // Format the readings JSON
      const readingsJSON = formatReadingsJSON();

      // Create the calibration
      await createCalibration({
        name: calibrationFileName,
        polynomialCoefficientsCommaDelimited: polynomialCoefficients.join(','),
        readingsJSONString: JSON.stringify(readingsJSON)
      });

      // Reset form
      setCalibrationFileName('');
      // setSelectedSensors([]);
      // setPolynomialCoefficients([]);
      // setCurvePoints([]);
      // setRSquared(null);
      // setShowCurve(false);
      // setSensorValues({});

      mutateCalibrations();
      alert('Calibration saved successfully');
    } catch (error) {
      console.error('Error saving calibration:', error);
      setErrorMessage('Failed to save calibration. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  // Add a row to calibration values
  const addCalibrationRow = () => {
    if (calibrationValues.length >= 10) return; // Maximum 10 rows

    const newValue = calibrationValues.length > 0
      ? calibrationValues[calibrationValues.length - 1] + 10
      : 10;

    setCalibrationValues([...calibrationValues, newValue]);

    // Update sensor values to include new row
    const newSensorValues = {...sensorValues};
    Object.keys(newSensorValues).forEach(sensorId => {
      const numId = parseInt(sensorId);
      newSensorValues[numId] = [...newSensorValues[numId], 0];
    });
    setSensorValues(newSensorValues);

    // Update average readings
    setAverageReadings([...averageReadings, 0]);
  };

  // Remove the last row from calibration values
  const removeCalibrationRow = () => {
    if (calibrationValues.length <= 4) return; // Minimum 4 rows

    const newValues = [...calibrationValues];
    newValues.pop();
    setCalibrationValues(newValues);

    // Update sensor values to remove last row
    const newSensorValues = {...sensorValues};
    Object.keys(newSensorValues).forEach(sensorId => {
      const numId = parseInt(sensorId);
      newSensorValues[numId] = newSensorValues[numId].slice(0, -1);
    });
    setSensorValues(newSensorValues);

    // Update average readings
    setAverageReadings(averageReadings.slice(0, -1));
  };

  // Clear the form
  const handleClearForm = () => {
    setSelectedSensors([])
    setCalibrationValues([10, 20, 40, 50, 70, 80])
    setSensorValues({})
    setPolynomialCoefficients([])
    setCurvePoints([])
    setRSquared(null)
    setShowCurve(false)
    setPolynomialDegree(undefined)
    setCalibrationFileName('')
    setErrorMessage(null)
    calculateAverages([])
  }

  // Delete a calibration with optimistic UI update
  const handleDeleteCalibration = async (id: number) => {
    const previous = calibrations ?? []
    // Optimistically remove from UI
    mutateCalibrations(previous.filter(c => c.id !== id), false)
    try {
      await deleteCalibration(id)
      // Revalidate to ensure server state is in sync
      await mutateCalibrations()
    } catch (err) {
      console.error('Failed to delete calibration', err)
      // Rollback on error
      mutateCalibrations(previous, false)
      alert('Error deleting calibration. Please try again.')
    }
  }

  if (connectedDevicesLoading || calibrationsLoading) {
    return (
      <div className="container mx-auto p-6">
        <p>Loading data...</p>
      </div>
    )
  }

  return (
    <ProtectedLayout>
        <div className="container mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Calibrations</h1>
            <p className="text-sm text-gray-500">Create a &quot;Calibration&quot; for your sensors to then apply it onto its pairing.</p>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
          >
            Back to Dashboard
          </button>
        </div>


          {/* Main content grid */}
          <div className="grid xl:grid-cols-5 gap-6">
            {/* Left Panel: Calibration Table */}
            <div className="bg-white rounded-lg border shadow-sm xl:col-span-3">
              <div className="p-6 flex flex-row items-center justify-between border-b">
                <h3 className="text-lg font-semibold">Calibration</h3>
                <button
                  onClick={handleClearForm}
                  className="px-4 py-2 border rounded-md hover:bg-gray-50 flex items-center"
                >
                  Clear Form
                </button>
              </div>

              <div className="p-4">
                <div className="mb-4 flex flex-row items-center justify-start gap-4">
                  <div className="relative flex-grow max-w-xs">
                    <input
                      type="text"
                      placeholder="Calibration File Name"
                      className={`w-full px-3 py-2 border rounded-md ${nameExists ? 'border-red-500' : ''}`}
                      value={calibrationFileName}
                      onChange={(e) => setCalibrationFileName(e.target.value)}
                    />
                    {isCheckingName && (
                      <div className="absolute right-2 top-2">
                        <SpinningLoader svgClassName="h-5 w-5" />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleSaveCalibration()}
                    className={`px-4 py-2 border rounded-md hover:bg-gray-50
                      ${(!polynomialCoefficients.length || !calibrationFileName || nameExists || isSaving)
                        ? 'opacity-50 cursor-not-allowed' : ''}`}
                    disabled={!polynomialCoefficients.length || !calibrationFileName || nameExists || isSaving}
                  >
                    {isSaving ? <SpinningLoader svgClassName="h-5 w-5" /> : 'Save Calibration'}
                  </button>
                </div>

                {errorMessage && (
                  <div className="mb-4 p-2 bg-red-50 text-red-600 border border-red-200 rounded-md text-sm">
                    {errorMessage}
                  </div>
                )}

                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Add Sensor</label>
                  <select
                    value=""
                    onChange={(e) => handleSensorChange(parseInt(e.target.value))}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  >
                    <option value="">Select a sensor</option>
                    {connectedDevices?.sensors?.filter(sensor => !selectedSensors.includes(sensor.id)).map((sensor) => (
                      <option key={sensor.id} value={sensor.id}>
                        Sensor ID {sensor.id}): {sensor.boardSerialId}:{sensor.address}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-md border max-h-[500px] overflow-y-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">VWC</th>
                        {selectedSensors.map(sensorId => {
                          const sensor = connectedDevices?.sensors?.find(s => s.id === sensorId);
                          return (
                            <th key={sensorId} className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                              <div className="flex items-center justify-between">
                                <span>
                                  Sensor ID {sensorId}
                                  {sensor ? `) ${sensor.boardSerialId}:${sensor.address}` : ''}
                                </span>
                                <button
                                  onClick={() => removeSensor(sensorId)}
                                  className="text-red-500 hover:text-red-700 text-xs ml-2"
                                >
                                  ×
                                </button>
                              </div>
                            </th>
                          );
                        })}
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Average Reading</th>
                      </tr>
                    </thead>
                    <tbody>
                      {calibrationValues.map((value, index) => (
                        <tr key={index} className="border-t">
                          <td className="px-4 py-3">
                            <input
                              type="number"
                              min="1"
                              max="100"
                              value={value}
                              onChange={(e) => handleValueChange(index, e.target.value)}
                              className="w-20 px-2 py-1 border rounded"
                            />
                          </td>
                          {selectedSensors.map(sensorId => (
                            <td key={sensorId} className="px-4 py-3">
                              <div className="flex items-center">
                                <input
                                  type="number"
                                  value={sensorValues[sensorId]?.[index] || 0}
                                  onChange={(e) => handleSensorValueChange(sensorId, index, e.target.value)}
                                  className="w-20 px-2 py-1 border rounded mr-2"
                                />
                                <button
                                  onClick={() => fetchSensorReading(sensorId, index)}
                                  disabled={fetchingReading?.sensorId === sensorId}
                                  className="text-blue-500 hover:text-blue-700 relative group"
                                  title="Click to fetch the Sensor&apos;s direct reading"
                                >
                                  {fetchingReading?.sensorId === sensorId && fetchingReading?.rowIndex === index ? (
                                    <SpinningLoader svgClassName="h-5 w-5" />
                                  ) : (
                                    <ArrowDownCircleIcon
                                      className={`h-5 w-5 ${fetchingReading?.sensorId === sensorId ? 'opacity-50 cursor-not-allowed' : ''}`} />
                                  )}
                                </button>
                              </div>
                            </td>
                          ))}
                          <td className="px-4 py-3 font-medium">
                            {averageReadings[index] || 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="border-t py-3 px-4 bg-gray-50 flex justify-between items-center">
                    <span className="text-sm text-gray-500">{calibrationValues.length} rows</span>
                    <div className="flex space-x-2">
                      <button
                        onClick={removeCalibrationRow}
                        disabled={calibrationValues.length <= 4}
                        className={`px-3 py-1.5 border rounded-md hover:bg-gray-100 text-sm
                          ${calibrationValues.length <= 4 ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Remove last row"
                      >
                        - Row
                      </button>
                      <button
                        onClick={addCalibrationRow}
                        disabled={calibrationValues.length >= 10}
                        className={`px-3 py-1.5 border rounded-md hover:bg-gray-100 text-sm
                          ${calibrationValues.length >= 10 ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Add new row"
                      >
                        + Row
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Panel: Calibration Chart */}
            <div className="bg-white rounded-lg border shadow-sm xl:col-span-2">
              <div className="p-6 border-b">
                <h3 className="text-lg font-semibold">Plot</h3>
              </div>
              <div className="p-6">
                {/* Chart container */}
                <div className="h-[400px]" ref={chartContainerRef}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="average"
                        type="number"
                        name="Reading"
                        label={{ value: 'Average Sensor Reading', position: 'bottom' }}
                      />
                      <YAxis
                        dataKey="vwc"
                        name="VWC"
                        label={{ value: 'VWC', angle: -90, position: 'insideLeft' }}
                        domain={[0, 80]}
                      />
                      <Tooltip
                        cursor={{ strokeDasharray: '3 3' }}
                        formatter={(value, name) => [value, name === 'vwc' ? 'VWC' : 'Raw Reading']}
                      />

                      {/* Data points */}
                      <Scatter
                        name="Calibration Points"
                        data={chartData.filter(point => point.average > 0)}
                        fill="#2563eb"
                      />

                      {/* Best fit curve */}
                      {showCurve && polynomialCoefficients.length > 0 && curvePoints.length > 0 && (
                        <Line
                          name="Best Fit Curve"
                          data={curvePoints}
                          type="monotone"
                          dataKey="vwc"
                          stroke="#dc2626"
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                          connectNulls={true}
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {/* Polynomial equation and R² display */}
                {polynomialDegree !== 'manual' && showCurve && polynomialCoefficients.length > 0 && rSquared !== null && (
                  <div className="mt-4 p-3 bg-gray-50 border rounded-md">
                    <p className="text-sm font-medium">
                      <span className="text-gray-700">Best Fit:</span>
                      <span className="ml-2">y = {formatPolynomialEquation(polynomialCoefficients)}</span>
                    </p>
                    <p className="text-sm font-medium mt-1">
                      <span className="text-gray-700">R²:</span>
                      <span className={`ml-2 ${rSquared > 0.95 ? 'text-green-600' : rSquared > 0.85 ? 'text-yellow-600' : 'text-red-600'}`}>
                        {rSquared.toFixed(4)}
                      </span>
                    </p>
                  </div>
                )}

                {polynomialDegree === 'manual' && polynomialCoefficients.length > 0 && (
                  <div className="mt-4 p-3 bg-gray-50 border rounded-md">
                    <p className="text-sm font-medium">
                      <span className="text-gray-700">Manual Function:</span>
                      <span className="ml-2">y = {formatPolynomialEquation(polynomialCoefficients)}</span>
                    </p>
                  </div>
                )}

                {/* Polynomial Degree Selection */}
                <div className="mt-6 flex items-center">
                  <span className="text-sm font-medium text-gray-700 mr-3">Polynomial Degree:</span>
                  <div className="flex space-x-2">
                    <button
                        key={1}
                        onClick={() => setDegreeAndCalculate(1)}
                        className={`px-3 py-1.5 text-sm font-medium rounded transition-colors
                          ${polynomialDegree === 1
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                      >
                        1st degree (Linear)
                      </button>
                      <button
                        key={3}
                        onClick={() => setDegreeAndCalculate(3)}
                        className={`px-3 py-1.5 text-sm font-medium rounded transition-colors
                          ${polynomialDegree === 3
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                      >
                        3rd degree Polynomial
                      </button>
                      <button
                        key={-1}
                        onClick={() => {
                          setDegreeAndCalculate('manual')
                          setPolynomialCoefficients([])
                        }}
                        className={`px-3 py-1.5 text-sm font-medium rounded transition-colors
                          ${polynomialDegree === 'manual'
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                      >
                        Manual Function
                      </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Existing Calibrations Section - New */}
          <div className="bg-white rounded-lg border shadow-sm">
            <div className="p-6 border-b">
              <h2 className="text-lg font-semibold">Existing Calibrations</h2>
            </div>

            {calibrations && calibrations.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Name</th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Function</th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Created</th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 ml-auto">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calibrations.map((calibration) => (
                      <tr key={calibration.id} className="border-t hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm">{calibration.name}</td>
                        <td className="px-4 py-3 text-sm font-mono">{formatPolynomialFunction(calibration.polynomialCoefficientsCommaDelimited)}</td>
                        <td className="px-4 py-3 text-sm">{new Date(calibration.createdAt).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-sm">
                          <button className="text-gray-600 hover:text-red-500" onClick={() => handleDeleteCalibration(calibration.id)}>
                            <TrashIcon className="h-5 w-5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-6 text-center text-gray-500">
                {calibrationsLoading ? (
                  <div className="flex justify-center items-center">
                    <SpinningLoader svgClassName="w-6 h-6" />
                    <span className="ml-2">Loading calibrations...</span>
                  </div>
                ) : (
                  <p>No calibrations found. Create one above.</p>
                )}
              </div>
            )}
          </div>
        </div>
    </ProtectedLayout>
  )
}
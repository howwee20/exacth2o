import { IPairing, MachineState, PairingState, PairingStateType } from './types'
import { ApiService } from './services/ApiService'
import { PairingService } from './services/PairingService'
import { ValveService } from './services/ValveService'
import { SensorService } from './services/SensorService'
import { RulesEngineService } from './services/RulesEngineService'
import { BullQueueService, StateTransitionEvent } from './services/BullQueueService'
import { DEFAULT_BOARD_CONFIGS, API_ENDPOINTS, DEFAULT_TIMING } from './config/constants'
import { BoardConfig } from './controllers/Expand13Manager'
import { ManualPulseManager, ManualPulseRequest, ManualPulseResult } from './services/ManualPulseManager'
import {
  getValveOpenSafetyDecision,
  getWateringBand,
  hasCalibration,
  isFiniteNumber,
  isFreshMeasurement,
  isPercentValue,
  isWateringConfigEnabled,
  recordValveOpen,
  resetWateringWindow,
  shouldAttemptWatering,
} from './services/WateringSafety'

/**
 * Refactored StateMachine that orchestrates the various services
 * to manage the irrigation system state and operations
 */
class StateMachine {
  private state: MachineState = MachineState.STOPPED

  // Services
  private apiService: ApiService
  private pairingService: PairingService
  private valveService: ValveService
  private sensorService: SensorService
  private rulesEngineService: RulesEngineService
  private eventQueueService: BullQueueService
  private openValvePairId: string | null = null
  private manualPulseManager: ManualPulseManager

  constructor(apiURL: string, standardDelayTime: number = DEFAULT_TIMING.STANDARD_DELAY) {
    console.log('Setting up StateMachine')

    // Initialize services
    this.apiService = new ApiService(apiURL)
    this.pairingService = new PairingService(this.apiService, standardDelayTime)
    this.valveService = new ValveService(this.apiService)
    this.sensorService = new SensorService(this.apiService)
    this.rulesEngineService = new RulesEngineService()
    this.eventQueueService = new BullQueueService()
    this.manualPulseManager = new ManualPulseManager(
      process.env.MANUAL_PULSE_STATE_FILE || '/app/config/manual-pulses.json',
      (request) => this.operateManualPulseValve(request, 'OPEN'),
      (request) => this.operateManualPulseValve(request, 'CLOSE'),
      () => this.valveService.closeAllValves(),
      Number(process.env.MANUAL_PULSE_MAX_MILLISECONDS || 60_000),
      Number(process.env.MANUAL_PULSE_MAX_COMMAND_VALVE_MILLISECONDS || 120_000),
    )

    // Set up event processing
    this.eventQueueService.setEventProcessor(this.processStateTransition.bind(this))

    // Initialize valve configurations
    const valveBoardConfigs = this.valveService.getValveBoardConfigs(true)
    this.valveService.setBoardConfigs(valveBoardConfigs.length > 0 ? valveBoardConfigs : DEFAULT_BOARD_CONFIGS, true)
  }

  async init(initializeHardware: boolean = true, assignAddresses: boolean = false): Promise<void> {
    console.log('Initializing StateMachine')
    this.state = MachineState.STARTUP

    const valveBoardConfigs = this.valveService.getValveBoardConfigs(initializeHardware)
    await this.valveService.setBoardConfigs(
      valveBoardConfigs.length > 0 ? valveBoardConfigs : DEFAULT_BOARD_CONFIGS,
      true
    )

    // A previous process may have died while a manual pulse was active. Close
    // that valve before loading pairings or entering RUNNING state.
    await this.manualPulseManager.recover()

    if (initializeHardware) {
      console.log('First time hardware initialization')
      await this.valveService.setupValveConfigs()
      await this.sensorService.setupSensorConfigs(assignAddresses)
    }

    console.log('Setup configurations for valves')
    await this.pairingService.fetchPairings()
    console.log('Fetched pairings from API')
    console.log(`Total pairings fetched: ${this.pairingService.getAllPairings().length}`)
    console.log('Setting state to RUNNING')
    this.state = MachineState.RUNNING
    console.log('StateMachine initialized')
  }

  async start(): Promise<void> {
    console.log('Starting StateMachine')
    this.openValvePairId = null
    this.eventQueueService.setLoadingPairings(true)
    // Ensure we start from a clean slate of pairings to prevent stale entries lingering
    console.log('Clearing existing in-memory pairings before startup/reload...')
    this.pairingService.clearPairings()
    console.log('Fetching pairings from API...')
    await this.pairingService.fetchPairings()

    console.log('🔍 Checking sensor health before starting pairings...')
    const sensorsHealthy = await this.sensorService.checkSensorHealth()
    if (!sensorsHealthy) {
      console.warn('⚠️  Sensor health check failed - forcing immediate sensor setup during startup')
      const setupSuccess = await this.sensorService.setupSensorConfigs(false)
      if (!setupSuccess) {
        console.error('❌ Forced sensor setup failed - pairings may not work correctly')
      } else {
        console.log('✅ Forced sensor setup completed successfully')
      }
    } else {
      console.log('✅ Sensor health check completed successfully')
    }

    // Clear queue BEFORE scheduling new initial transitions to avoid race
    console.log('clearing queue before startup...')
    await this.eventQueueService.clearQueue()

    console.log('📋 Starting pairings after sensor health verification...')
    for (const pairing of this.pairingService.getAllPairings()) {
      console.log(`Starting pairing: ${pairing.sensorId}-${pairing.valveId}`)
      // Start each pairing in STARTUP so rule STARTUP->MEASURING can fire
      await this.startPairing(pairing.sensorId, pairing.valveId, 'STARTUP')
    }

    this.eventQueueService.setLoadingPairings(false)
    console.log('Starting event loop')
    this.runEventLoop()
  }

  // Default state changed to STARTUP; now async so callers can await queue scheduling
  async startPairing(
    sensorId: number,
    valveId: number,
    state: PairingStateType = 'STARTUP',
    nextTransitionTime: number | null = null
  ): Promise<void> {
    const pairing = this.pairingService.getPairing(sensorId.toString(), valveId.toString())
    if (pairing) {
      // If pairing already persisted in non-STARTUP state, honor it (skip forcing STARTUP)
      const initialState = pairing.state ?? 'STARTUP'
      const desiredState: PairingStateType = initialState !== 'STARTUP' && state === 'STARTUP'
        ? (initialState as PairingStateType)
        : state

      pairing.nextTransitionTime = nextTransitionTime ?? Date.now()
      console.log(`Starting pairing: ${sensorId}-${valveId} with nextState ${desiredState}, nextTransitionTime: ${pairing.nextTransitionTime}`)
      await this.eventQueueService.queueStateTransition(pairing, desiredState)
    }
  }

  runEventLoop(): void {
    console.log('*')
    this.state = MachineState.RUNNING
    this.eventQueueService.processQueue()
  }

  async stopEventLoop(): Promise<void> {
    console.log('Stopping StateMachine event queue...')
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `Stopping StateMachine event queue`,
      source: 'StateMachine'
    })
    await this.eventQueueService.stop()
    console.log('StateMachine event queue stopped.')
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `StateMachine event queue stopped`,
      source: 'StateMachine'
    })

    // close all valves
    console.log('Closing all valves as part of stopping StateMachine...')
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `Closing all valves as part of stopping StateMachine`,
      source: 'StateMachine'
    })
    this.valveService.closeAllValves()
    this.openValvePairId = null
    console.log('All valves closed.')
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `All valves closed`,
      source: 'StateMachine'
    })
    this.state = MachineState.STOPPED
    console.log('StateMachine stopped.')
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `StateMachine stopped`,
      source: 'StateMachine'
    })
  }

  async shutdown(): Promise<void> {
    console.log('Shutting down StateMachine...')
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `Shutting down StateMachine`,
      source: 'StateMachine'
    })
    await this.manualPulseManager.closeActive()
    await this.stopEventLoop()
    await this.eventQueueService.close()
    console.log('StateMachine shutdown complete')
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `StateMachine shutdown complete`,
      source: 'StateMachine'
    })
  }

  private async processStateTransition(event: StateTransitionEvent): Promise<void> {
    const { pairing, newState } = event
    console.log(`[PROCESS] Executing transition job for ${pairing.sensorId}-${pairing.valveId}: current=${pairing.state} queued=${newState} at ${new Date().toISOString()}`)
    await this.checkRulesForPair(pairing, newState)
  }

  private async checkRulesForPair(pairing: PairingState, newState: PairingStateType): Promise<void> {
    const pairId = `${pairing.sensorId}-${pairing.valveId}`
    pairing.state = newState
    const currentState = pairing.state
    const currentTime = Date.now()
    const measurementFresh = isFreshMeasurement(pairing, currentTime, DEFAULT_TIMING.MAX_WATERING_READING_AGE)
    const wateringShouldOpen = (
      pairing.wateringMeasurementValid &&
      measurementFresh &&
      shouldAttemptWatering(
        pairing,
        currentTime,
        DEFAULT_TIMING.WATERING_SETTLE_WINDOW,
        DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT,
        DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT
      )
    )

    const facts = {
      state: newState,
      measurementTime: pairing.timingRules.measurementTime,
      delayTime: pairing.timingRules.delayTime,
      valveOpenTime: pairing.timingRules.valveOpenTime,
      intervalTime: pairing.timingRules.intervalTime,
      nextTransitionTime: pairing.nextTransitionTime,
      WTCPercentLimit: pairing.WTCPercentLimit,
      WTCPercentMeasured: pairing.WTCPercentMeasured,
      measurementValid: pairing.measurementValid && measurementFresh,
      wateringEnabled: isWateringConfigEnabled(pairing),
      wateringMeasurementValid: pairing.wateringMeasurementValid && measurementFresh,
      wateringShouldOpen,
      currentTime,
    }

    const { events } = await this.rulesEngineService.evaluateRules(facts)

    if (events.length === 0) {
      await this.eventQueueService.queueStateTransition(pairing, newState)
    } else {
      let finalState: PairingStateType = newState
      // Process all state transitions but only queue the final one
      for (const event of events) {
        const nextState = event.params?.newState
        const handledState = await this.handleStateTransition(pairing, nextState, pairId)
        console.log(`${new Date()}) Transitioning to new state: ${pairId} [ ${currentState} => ${nextState} ] ${pairing.nextTransitionTime! - Date.now()}`)
        finalState = handledState ?? nextState
      }
      // Only queue the final state transition to prevent out-of-order execution
      await this.eventQueueService.queueStateTransition(pairing, finalState)
    }
  }

  private async handleStateTransition(pairing: PairingState, nextState: PairingStateType, pairId: string): Promise<PairingStateType | null> {
    switch (nextState) {
      case 'MEASURING':
        await this.handleMeasuringState(pairing, pairId)
        return nextState
      case 'DELAY':
        await this.handleDelayState(pairing, pairId)
        return nextState
      case 'VALVE_OPEN':
        return await this.handleValveOpenState(pairing, pairId)
      case 'VALVE_CLOSE':
        return await this.handleValveCloseState(pairing, pairId)
      case 'IDLE':
        await this.handleIdleState(pairing, pairId)
        return nextState
      case 'DISABLED':
        await this.handleDisabledState(pairing, pairId)
        return nextState
      case 'SENSOR_FAULT':
        await this.handleSensorFaultState(pairing, pairId)
        return nextState
      default:
        return null
    }
  }

  private async handleMeasuringState(pairing: PairingState, pairId: string): Promise<void> {
    pairing.previousWTCPercentMeasured = isFiniteNumber(pairing.WTCPercentMeasured)
      ? pairing.WTCPercentMeasured
      : null
    pairing.previousMeasurementAt = isFiniteNumber(pairing.lastMeasurementAt)
      ? pairing.lastMeasurementAt
      : null
    pairing.measurementValid = false
    pairing.wateringMeasurementValid = false
    pairing.WTCPercentMeasured = null
    pairing.lastMeasurementAt = null

    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `Measuring phase: ${pairId}`,
      source: 'StateMachine'
    })
    console.log(`Measuring: ${pairId}`)

    try {
      const allData = await this.sensorService.operateSensor(pairing.Sensor.boardSerialId!, pairing.Sensor.address)
      if (allData === null || allData.length === 0) {
        console.error(`No data received from sensor ${pairing.Sensor.address} on board ${pairing.Sensor.boardSerialId}`)
        throw new Error(`No data received from sensor ${pairing.Sensor.address} on board ${pairing.Sensor.boardSerialId}`)
      }

      const data = allData[0]
      const rawValue = Number(data?.volumetricWaterContent)
      if (!isFiniteNumber(rawValue)) {
        throw new Error(`Invalid raw water content from sensor ${pairing.Sensor.address} on board ${pairing.Sensor.boardSerialId}: ${data?.volumetricWaterContent}`)
      }

      const coefficientsString = pairing.Calibration?.polynomialCoefficientsCommaDelimited || '0,1'
      const calibratedValue = this.sensorService.calibrateRawData(
        coefficientsString,
        rawValue
      )
      if (!isFiniteNumber(calibratedValue)) {
        throw new Error(`Invalid calibrated water content for ${pairId}: ${calibratedValue}`)
      }

      pairing.WTCPercentMeasured = calibratedValue
      pairing.measurementValid = true
      pairing.wateringMeasurementValid = hasCalibration(pairing) && isPercentValue(calibratedValue)
      pairing.lastMeasurementAt = Date.now()
      const wateringBand = getWateringBand(
        pairing,
        DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT,
        DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT
      )
      if (
        isWateringConfigEnabled(pairing) &&
        pairing.wateringMeasurementValid &&
        calibratedValue >= wateringBand.recoveryMax
      ) {
        resetWateringWindow(pairing)
      }

      const temperatureData = data?.temperature
      const electricalConductivityData = data?.electricalConductivity

      console.log(`Coefficients: ${coefficientsString}, Raw value: ${rawValue}, Calibrated value: ${calibratedValue} for sensor ${pairing.Sensor.address} pairing ${pairId}`)
      console.log(`Sending Calibrated value: ${calibratedValue}, Raw value: ${rawValue} for sensor ${pairing.Sensor.address}/pairing ${pairId}`)
      await this.apiService.postData(API_ENDPOINTS.READINGS, {
        sensorId: pairing.sensorId,
        rawValue,
        calibratedValue,
        temperature: temperatureData,
        electricalConductivity: electricalConductivityData
      })
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'info',
        message: `Measured: ${pairId}: ${pairing.Sensor.boardSerialId}:${pairing.Sensor.address}. Calibrated value: ${calibratedValue}, Raw value: ${rawValue}, Temperature: ${temperatureData}, Electrical Conductivity: ${electricalConductivityData}`,
        source: 'StateMachine'
      })

      if (
        isWateringConfigEnabled(pairing) &&
        pairing.wateringMeasurementValid &&
        calibratedValue < wateringBand.floor
      ) {
        await this.apiService.postData(API_ENDPOINTS.LOGS, {
          level: 'warn',
          message: `FLOOR_BREACH: ${pairId}; measured=${calibratedValue.toFixed(2)} floor=${wateringBand.floor.toFixed(2)} trigger=${wateringBand.trigger.toFixed(2)} recovery=${wateringBand.recoveryMax.toFixed(2)} pulseCount=${pairing.wateringWindowPulseCount}`,
          source: 'StateMachine'
        })
      }

      if (isWateringConfigEnabled(pairing) && !pairing.wateringMeasurementValid) {
        await this.apiService.postData(API_ENDPOINTS.LOGS, {
          level: 'error',
          message: `Watering measurement rejected for ${pairId}: calibrated value is not a valid 0-100 percent reading`,
          source: 'StateMachine'
        })
      }
    } catch (error) {
      console.error('Error getting sensor data:', error)
      pairing.measurementValid = false
      pairing.wateringMeasurementValid = false
      pairing.WTCPercentMeasured = null
      pairing.lastMeasurementAt = null
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'error',
        message: `Error getting sensor data: ${pairId}; watering blocked until a fresh valid reading succeeds`,
        source: 'StateMachine'
      })
      pairing.nextTransitionTime = Date.now()
      return
    }

    pairing.nextTransitionTime = Date.now() + pairing.timingRules.measurementTime
  }

  private async handleDelayState(pairing: PairingState, pairId: string): Promise<void> {
    pairing.nextTransitionTime = Date.now() + pairing.timingRules.delayTime
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `Delay phase for: ${pairId}`,
      source: 'StateMachine'
    })
  }

  private async handleValveOpenState(pairing: PairingState, pairId: string): Promise<PairingStateType> {
    try {
      const livePairing = await this.getLivePairing(pairing)
      if (!livePairing) {
        await this.logValveOpenBlocked(pairId, 'pairing no longer exists or API re-check failed')
        pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime
        return 'IDLE'
      }

      this.applyLivePairingConfig(pairing, livePairing)

      const decision = getValveOpenSafetyDecision(
        pairing,
        Date.now(),
        DEFAULT_TIMING.MAX_WATERING_READING_AGE,
        DEFAULT_TIMING.WATERING_SETTLE_WINDOW,
        DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW,
        DEFAULT_TIMING.MIN_WATERING_RETRY,
        DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT,
        DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT
      )
      if (!decision.allowed) {
        await this.logValveOpenBlocked(
          pairId,
          decision.reason || 'safety guard rejected valve open',
          decision.normalHold ? 'info' : 'error'
        )
        pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime
        return decision.fault ? 'SENSOR_FAULT' : 'IDLE'
      }

      if (this.openValvePairId && this.openValvePairId !== pairId) {
        await this.logValveOpenBlocked(
          pairId,
          `another valve is already open: ${this.openValvePairId}; retrying in ${DEFAULT_TIMING.VALVE_CONFLICT_RETRY_DELAY}ms`,
          'info'
        )
        pairing.nextTransitionTime = Date.now() + DEFAULT_TIMING.VALVE_CONFLICT_RETRY_DELAY
        return 'DELAY'
      }

      pairing.nextTransitionTime = Date.now() + pairing.timingRules.valveOpenTime
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'info',
        message: `Valve open phase: ${pairId}`,
        source: 'StateMachine'
      })
      console.log(`Opening valve: ${pairId}`)

      const boardConfigAddress = Number(pairing.Valve.relayAddress)
      const address = Number(pairing.Valve.address)
      const { column, pin } = this.valveService.calculateColumnAndPin(address)
      this.valveService.operateValve(boardConfigAddress, column, pin, 'OPEN')
      this.openValvePairId = pairId
      pairing.valveOpened = true
      recordValveOpen(pairing, Date.now(), DEFAULT_TIMING.WATERING_SETTLE_WINDOW)
      console.log(`Valve ${pairId} opened successfully`)
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'info',
        message: `Opened Valve: ${pairId}; measured=${isFiniteNumber(pairing.WTCPercentMeasured) ? pairing.WTCPercentMeasured.toFixed(2) : 'unknown'} floor=${getWateringBand(pairing, DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT).floor.toFixed(2)} trigger=${getWateringBand(pairing, DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT).trigger.toFixed(2)} recovery=${getWateringBand(pairing, DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT).recoveryMax.toFixed(2)} pulseCount=${pairing.wateringWindowPulseCount}`,
        source: 'StateMachine'
      })
      return 'VALVE_OPEN'
    } catch (error) {
      console.error(`Error opening valve ${pairId}:`, error)
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'error',
        message: `Error opening valve ${pairId}; watering blocked: ${error}`,
        source: 'StateMachine'
      })
      pairing.valveOpened = false
      pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime
      return 'IDLE'
    }
  }

  private async handleValveCloseState(pairing: PairingState, pairId: string): Promise<PairingStateType> {
    if (!pairing.valveOpened && this.openValvePairId !== pairId) {
      console.log(`Skipping close for ${pairId}; this scheduler did not open that valve`)
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'info',
        message: `Skipped Valve Close: ${pairId}; valve was not opened by scheduler`,
        source: 'StateMachine'
      })
      pairing.nextTransitionTime = Date.now()
      return 'IDLE'
    }

    pairing.nextTransitionTime = Date.now() + DEFAULT_TIMING.STANDARD_VALVE_CLOSE
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `Valve close phase: ${pairId}`,
      source: 'StateMachine'
    })
    console.log(`Closing valve: ${pairId}`)

    try {
      const boardConfigAddress = Number(pairing.Valve.relayAddress)
      const address = Number(pairing.Valve.address)
      const { column, pin } = this.valveService.calculateColumnAndPin(address)
      this.valveService.operateValve(boardConfigAddress, column, pin, 'CLOSE')
      console.log(`Valve ${pairId} closed successfully`)
      if (this.openValvePairId === pairId) {
        this.openValvePairId = null
      }
      pairing.valveOpened = false
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'info',
        message: `Closed Valve: ${pairId}`,
        source: 'StateMachine'
      })
      return 'VALVE_CLOSE'
    } catch (error) {
      console.error(`Error closing valve ${pairId}:`, error)
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'error',
        message: `Error closing valve ${pairId}: ${error}`,
        source: 'StateMachine'
      })
      return 'VALVE_CLOSE'
    }
  }

  private async handleIdleState(pairing: PairingState, pairId: string): Promise<void> {
    pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `Idle/Interval phase : ${pairId}`,
      source: 'StateMachine'
    })
  }

  private async handleDisabledState(pairing: PairingState, pairId: string): Promise<void> {
    pairing.nextTransitionTime = null
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'info',
      message: `Disabling: ${pairId}`,
      source: 'StateMachine'
    })
  }

  private async handleSensorFaultState(pairing: PairingState, pairId: string): Promise<void> {
    pairing.WTCPercentMeasured = null
    pairing.measurementValid = false
    pairing.wateringMeasurementValid = false
    pairing.lastMeasurementAt = null
    pairing.valveOpened = false
    pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level: 'error',
      message: `Sensor fault fail-closed: ${pairId}; no watering until a fresh valid reading succeeds`,
      source: 'StateMachine'
    })
  }

  private async getLivePairing(pairing: PairingState): Promise<IPairing | null> {
    try {
      return await this.apiService.fetchData(`${API_ENDPOINTS.PAIRINGS}/${pairing.sensorId}/${pairing.valveId}`)
    } catch (error) {
      console.error(`Failed final pairing re-check for ${pairing.sensorId}-${pairing.valveId}:`, error)
      return null
    }
  }

  private applyLivePairingConfig(pairing: PairingState, livePairing: IPairing): void {
    pairing.WTCPercentLimit = livePairing.WTCPercentLimit
    pairing.ValveOpenTime = livePairing.ValveOpenTime
    pairing.MeasurementInterval = livePairing.MeasurementInterval
    pairing.Calibration = livePairing.Calibration
    pairing.timingRules.valveOpenTime = livePairing.ValveOpenTime
    pairing.timingRules.intervalTime = livePairing.MeasurementInterval
  }

  private async logValveOpenBlocked(pairId: string, reason: string, level: 'info' | 'error' = 'error'): Promise<void> {
    console.warn(`Valve open blocked for ${pairId}: ${reason}`)
    await this.apiService.postData(API_ENDPOINTS.LOGS, {
      level,
      message: `Valve open blocked: ${pairId}; ${reason}`,
      source: 'StateMachine'
    })
  }

  // Public API methods
  getPairingState(sensorId: string, valveId: string): PairingState | undefined {
    return this.pairingService.getPairing(sensorId, valveId)
  }

  setPairingState(sensorId: string, valveId: string, newState: PairingStateType): void {
    this.pairingService.setPairingState(sensorId, valveId, newState)
  }

  getAllPairingStates(): PairingState[] {
    return this.pairingService.getAllPairings()
  }

  disablePairing(sensorId: string, valveId: string): void {
    const pairing = this.pairingService.getPairing(sensorId, valveId)
    if (pairing) {
      console.log(`Disabling pairing: ${sensorId}-${valveId}`)
      // Note: Not awaiting here since this is a synchronous public method
      this.eventQueueService.queueStateTransition(pairing, 'DISABLED')
    }
  }

  getBoardConfigs(): BoardConfig[] {
    return this.valveService.getBoardConfigs()
  }

  async setBoardConfigs(boardConfigs: BoardConfig[], updateAPI: boolean = false): Promise<boolean> {
    return await this.valveService.setBoardConfigs(boardConfigs, updateAPI)
  }

  async pulseManualValve(request: ManualPulseRequest): Promise<ManualPulseResult> {
    const manualKey = `manual:${request.pulseId}`
    if (this.openValvePairId && this.openValvePairId !== manualKey) {
      throw new Error(`another valve is already open: ${this.openValvePairId}`)
    }

    this.openValvePairId = manualKey
    try {
      const result = await this.manualPulseManager.pulse(request)
      if (!this.manualPulseManager.hasActivePulse() && this.openValvePairId === manualKey) {
        this.openValvePairId = null
      }
      return result
    } catch (error) {
      if (!this.manualPulseManager.hasActivePulse() && this.openValvePairId === manualKey) {
        this.openValvePairId = null
      }
      throw error
    }
  }

  private operateManualPulseValve(request: ManualPulseRequest, state: 'OPEN' | 'CLOSE'): void {
    const boardAddress = Number(request.relayAddress)
    const { column, pin } = this.valveService.calculateColumnAndPin(Number(request.address))
    this.valveService.operateValve(boardAddress, column, pin, state)
    if (state === 'CLOSE' && this.openValvePairId === `manual:${request.pulseId}`) {
      this.openValvePairId = null
    }
  }

  async setState(state: MachineState): Promise<void> {
    this.state = state
    console.log(`StateMachine state set to: ${MachineState[state]}`)

    switch (state) {
      case MachineState.STARTUP:
      case MachineState.UPDATE:
        await this.stopEventLoop()
        await this.init(false)
        await this.start()
        break
      case MachineState.RUNNING:
        await this.start()
        break
      case MachineState.STOPPED:
        await this.stopEventLoop()
        break
      case MachineState.RESET:
        await this.stopEventLoop()
        await this.init()
        break
      default:
        console.error(`Unknown state: ${state}`)
        break
    }
  }

  getState(): MachineState {
    return this.state
  }

  pairingsLoaded(): boolean {
    return this.pairingService.isPairingsFetched()
  }

  async operateSensor(boardSerialId: string, sensorAddress: string, measurements: number = 1): Promise<any> {
    return await this.sensorService.operateSensor(boardSerialId, sensorAddress, measurements)
  }

  calculateColumnAndPin(address: number): { column: number; pin: number } {
    return this.valveService.calculateColumnAndPin(address)
  }

  operateValve(boardAddress: number, column: number, pin: number, state: 'OPEN' | 'CLOSE'): void {
    return this.valveService.operateValve(boardAddress, column, pin, state)
  }

  async getQueueStats(): Promise<any> {
    return await this.eventQueueService.getQueueStats()
  }

  async clearStuckJobs(): Promise<void> {
    console.log('Clearing stuck jobs from StateMachine...')
    await this.eventQueueService.clearStuckJobs()
  }

  async logQueueSummary(): Promise<void> {
    await this.eventQueueService.logQueueSummary()
  }

}

export default StateMachine

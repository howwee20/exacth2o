import { EndReason, HoldAction, HoldError, HoldRoute, HoldSession, HoldSignal, ManualHoldManager } from './services/ManualHoldManager'
import { ValveArbiter, monotonicMs } from './services/ValveArbiter'
import { IPairing, MachineState, PairingState, PairingStateType } from './types'
import { ApiService } from './services/ApiService'
import { PairingService } from './services/PairingService'
import { ValveService } from './services/ValveService'
import { SensorService } from './services/SensorService'
import { RulesEngineService } from './services/RulesEngineService'
import { BullQueueService, StateTransitionEvent } from './services/BullQueueService'
import { DEFAULT_BOARD_CONFIGS, API_ENDPOINTS, DEFAULT_TIMING, VALVE_CONFIGURATION } from './config/constants'
import { BoardConfig } from './controllers/Expand13Manager'
import { ManualPulseManager, ManualPulseRequest, ManualPulseResult } from './services/ManualPulseManager'
import { ActiveAutomaticPulse, WateringPulseLedger } from './services/WateringPulseLedger'
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
  private lastValveClosedAt: number | null = null
  private manualHoldManager: ManualHoldManager
  private manualPulseManager: ManualPulseManager
  private wateringPulseLedger: WateringPulseLedger
  // The single arbitration policy every opening path consults before taking openValvePairId.
  private arbiter: ValveArbiter
  private watchdogReconciled = false
  private valveInventory: { at: number; keys: Set<string> } | null = null

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
    this.arbiter = new ValveArbiter(
      monotonicMs,
      Number(process.env.MANUAL_HOLD_SETTLE_MS || 60_000),
      Number(process.env.MANUAL_HOLD_PULSE_QUIET_MS || 120_000),
    )
    const maxContinuous = Number(process.env.EXACTH2O_VALVE_MAX_CONTINUOUS_ON_MS || 0)
    this.manualHoldManager = new ManualHoldManager(
      process.env.MANUAL_HOLD_STATE_FILE || '/app/config/manual-holds.json',
      {
        acquire: (session) => this.acquireForHold(session),
        open: (session) => this.openManualHold(session),
        close: (session) => this.closeManualHold(session),
        release: (session, reason) => this.releaseManualHold(session, reason),
        onFault: (session, error) => this.arbiter.recordFault(`hold ${session.sessionId} close unconfirmed: ${error instanceof Error ? error.message : String(error)}`, 'close_failed'),
      },
      {
        leaseMs: Number(process.env.MANUAL_HOLD_LEASE_MS || 2_500),
        // No continuous-on cap is imposed unless the valve/supply ratings call for one.
        maxContinuousMs: Number.isFinite(maxContinuous) && maxContinuous > 0 ? maxContinuous : null,
      },
    )
    this.wateringPulseLedger = new WateringPulseLedger(
      process.env.AUTOMATIC_PULSE_LEDGER_PATH || '/app/config/automatic-pulses.json'
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
    await this.manualHoldManager.recover()
    // Give the shared supply the same recovery time after startup close-all as
    // it receives between normal automatic pulses.
    this.lastValveClosedAt = Date.now()
    // Automatic watering remains fail-closed until the durable per-pot pulse
    // ledger has been restored. Keep sensing alive if the ledger is damaged;
    // later watering attempts will be rejected because it is uninitialized.
    let automaticLedgerReady = false
    try {
      await this.wateringPulseLedger.init()
      automaticLedgerReady = true
    } catch (error) {
      console.error('Automatic watering disabled: durable pulse ledger could not be restored', error)
    }
    if (automaticLedgerReady) {
      const activePulse = this.wateringPulseLedger.activePulse()
      if (activePulse) {
        console.warn(`Recovering automatic valve left active by a previous process: ${activePulse.pairId}`)
        await this.closeAutomaticPulseWithFallback(activePulse)
        await this.wateringPulseLedger.completeActive(activePulse.pairId)
        this.openValvePairId = null
        this.lastValveClosedAt = Date.now()
      }
    }

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
    // A hold may be running while the controller is STOPPED. End it before the
    // shared valve lock is reset, so automatic watering cannot open a second valve.
    await this.manualHoldManager.stopAll()
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
    await this.manualHoldManager.stopAll()
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
    // STOPPED cancels the queued close transition. Retire its active marker
    // only after close-all succeeds; retain the per-pot pulse history/limits.
    const activePulse = this.wateringPulseLedger.activePulse()
    if (activePulse) {
      await this.wateringPulseLedger.completeActive(activePulse.pairId)
    }
    this.openValvePairId = null
    this.lastValveClosedAt = Date.now()
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

      const arbitration = this.arbiter ? this.arbiter.automaticOpen() : { allowed: true as const }
      if (!arbitration.allowed) {
        // Manual troubleshooting, its settling window, a topology rewrite or a valve
        // fault takes priority. Retry later without changing any saved setting.
        const retryDelay = arbitration.retryInMs ?? pairing.timingRules.intervalTime
        await this.logValveOpenBlocked(pairId, `${arbitration.reason}; retrying in ${Math.round(retryDelay)}ms`, 'info')
        pairing.nextTransitionTime = Date.now() + retryDelay
        return arbitration.retryInMs == null ? 'IDLE' : 'DELAY'
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

      const now = Date.now()
      if (
        DEFAULT_TIMING.VALVE_RECOVERY_DELAY > 0 &&
        isFiniteNumber(this.lastValveClosedAt) &&
        now - this.lastValveClosedAt < DEFAULT_TIMING.VALVE_RECOVERY_DELAY
      ) {
        const retryDelay = DEFAULT_TIMING.VALVE_RECOVERY_DELAY - (now - this.lastValveClosedAt)
        await this.logValveOpenBlocked(
          pairId,
          `shared water supply is recovering; retrying in ${retryDelay}ms`,
          'info'
        )
        pairing.nextTransitionTime = now + retryDelay
        return 'DELAY'
      }

      let durablePulse
      try {
        durablePulse = await this.wateringPulseLedger.reserve(
          pairId,
          now,
          DEFAULT_TIMING.WATERING_SETTLE_WINDOW,
          DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW,
          DEFAULT_TIMING.MIN_WATERING_RETRY,
        )
      } catch (error) {
        await this.logValveOpenBlocked(
          pairId,
          `durable pulse ledger unavailable; watering failed closed: ${error}`,
          'error'
        )
        pairing.nextTransitionTime = now + pairing.timingRules.intervalTime
        return 'IDLE'
      }

      if (!durablePulse.allowed) {
        await this.logValveOpenBlocked(
          pairId,
          `durable per-pot ${durablePulse.reason} guard active; count=${durablePulse.pulseCount} retryAt=${durablePulse.retryAt ? new Date(durablePulse.retryAt).toISOString() : 'unknown'}`,
          'info'
        )
        pairing.nextTransitionTime = now + pairing.timingRules.intervalTime
        return 'IDLE'
      }

      const boardConfigAddress = Number(pairing.Valve.relayAddress)
      const address = Number(pairing.Valve.address)
      const activePulse = await this.wateringPulseLedger.beginActive(
        pairId,
        boardConfigAddress,
        address,
        Date.now(),
      )
      this.openValvePairId = pairId
      pairing.valveOpened = true
      pairing.nextTransitionTime = Date.now() + pairing.timingRules.valveOpenTime
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'info',
        message: `Valve open phase: ${pairId}`,
        source: 'StateMachine'
      })
      console.log(`Opening valve: ${pairId}`)

      this.operateAutomaticPulseValve(activePulse, 'OPEN')
      recordValveOpen(pairing, Date.now(), DEFAULT_TIMING.WATERING_SETTLE_WINDOW)
      console.log(`Valve ${pairId} opened successfully`)
      try {
        await this.apiService.postData(API_ENDPOINTS.LOGS, {
          level: 'info',
          message: `Opened Valve: ${pairId}; measured=${isFiniteNumber(pairing.WTCPercentMeasured) ? pairing.WTCPercentMeasured.toFixed(2) : 'unknown'} floor=${getWateringBand(pairing, DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT).floor.toFixed(2)} trigger=${getWateringBand(pairing, DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT).trigger.toFixed(2)} recovery=${getWateringBand(pairing, DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT).recoveryMax.toFixed(2)} pulseCount=${pairing.wateringWindowPulseCount}`,
          source: 'StateMachine'
        })
      } catch (error) {
        console.error(`Valve ${pairId} opened, but the audit log write failed:`, error)
      }
      return 'VALVE_OPEN'
    } catch (error) {
      console.error(`Error opening valve ${pairId}:`, error)
      try {
        await this.apiService.postData(API_ENDPOINTS.LOGS, {
          level: 'error',
          message: `Error opening valve ${pairId}; watering blocked: ${error}`,
          source: 'StateMachine'
        })
      } catch (logError) {
        console.error(`Failed to write valve-open error log for ${pairId}:`, logError)
      }
      const activePulse = this.wateringPulseLedger.activePulse()
      if (activePulse?.pairId === pairId) {
        this.openValvePairId = pairId
        pairing.valveOpened = true
        pairing.nextTransitionTime = Date.now() + DEFAULT_TIMING.STANDARD_VALVE_CLOSE
        return 'VALVE_OPEN'
      }
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
      const activePulse = this.wateringPulseLedger.activePulse()
      const closeTarget = activePulse?.pairId === pairId
        ? activePulse
        : {
            pairId,
            relayAddress: Number(pairing.Valve.relayAddress),
            address: Number(pairing.Valve.address),
            startedAt: Date.now(),
          }
      await this.closeAutomaticPulseWithFallback(closeTarget)
      if (activePulse?.pairId === pairId) {
        await this.wateringPulseLedger.completeActive(pairId)
      }
      console.log(`Valve ${pairId} closed successfully`)
      this.lastValveClosedAt = Date.now()
      if (this.openValvePairId === pairId) {
        this.openValvePairId = null
      }
      pairing.valveOpened = false
      try {
        await this.apiService.postData(API_ENDPOINTS.LOGS, {
          level: 'info',
          message: `Closed Valve: ${pairId}`,
          source: 'StateMachine'
        })
      } catch (error) {
        console.error(`Valve ${pairId} closed, but the audit log write failed:`, error)
      }
      return 'VALVE_CLOSE'
    } catch (error) {
      console.error(`Error closing valve ${pairId}:`, error)
      try {
        await this.apiService.postData(API_ENDPOINTS.LOGS, {
          level: 'error',
          message: `Error closing valve ${pairId}; retrying closure before any further watering: ${error}`,
          source: 'StateMachine'
        })
      } catch (logError) {
        console.error(`Failed to write valve-close error log for ${pairId}:`, logError)
      }
      pairing.valveOpened = true
      this.openValvePairId = pairId
      pairing.nextTransitionTime = Date.now() + DEFAULT_TIMING.STANDARD_VALVE_CLOSE
      return 'VALVE_OPEN'
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

  // ---------------------------------------------------------------- manual hold

  private routeKey(relayAddress: number, address: number) {
    return `${relayAddress}:${address}`
  }

  /** The output must exist in the controller's own valve inventory, not just be a plausible address. */
  private async assertConfiguredOutput(route: HoldRoute): Promise<void> {
    if (!this.valveService.getBoardConfigs().some((board) => board.address === route.relayAddress)) {
      throw new HoldError('Valve board unavailable', 'route')
    }
    if (!Number.isInteger(route.address) || route.address < 1 || route.address > VALVE_CONFIGURATION.COLS * VALVE_CONFIGURATION.ROWS) {
      throw new HoldError('Valve channel is outside the board', 'route')
    }
    const fresh = this.valveInventory && Date.now() - this.valveInventory.at < 60_000
    if (!fresh) {
      let valves: any[] = []
      try {
        valves = await this.apiService.fetchData(API_ENDPOINTS.VALVES, { timeoutMs: 1_500, retries: 0 })
      } catch {
        throw new HoldError('Valve inventory unavailable; manual watering cannot be started safely', 'unavailable')
      }
      const keys = new Set<string>()
      for (const valve of Array.isArray(valves) ? valves : []) {
        const relayText = String(valve?.relayAddress ?? valve?.RelayAddress ?? '').trim()
        const relay = /^0x/i.test(relayText) ? Number.parseInt(relayText, 16) : Number(relayText)
        const address = Number(valve?.address ?? valve?.Address)
        if (Number.isInteger(relay) && Number.isInteger(address)) keys.add(this.routeKey(relay, address))
      }
      this.valveInventory = { at: Date.now(), keys }
    }
    if (!this.valveInventory!.keys.has(this.routeKey(route.relayAddress, route.address))) {
      throw new HoldError('That output is not in the controller valve inventory', 'route')
    }
  }

  /**
   * Coordinated ownership transfer for a hold. Runs synchronously up to the first await,
   * so the arbitration check and the manual-control flag are atomic with respect to
   * every other request this process handles.
   */
  private async acquireForHold(session: HoldSession): Promise<void> {
    if (![MachineState.RUNNING, MachineState.STOPPED].includes(this.state)) {
      throw new HoldError('Controller is not ready for manual watering (starting or reloading)', 'unavailable')
    }
    const decision = this.arbiter.holdStart()
    if (!decision.allowed) throw new HoldError(`Manual watering unavailable: ${decision.reason}`, 'unavailable')
    if (this.openValvePairId?.startsWith('hold:') && this.openValvePairId !== `hold:${session.sessionId}`) {
      throw new HoldError('Another manual hold owns the output', 'busy')
    }
    // From here on automatic starts and timed pulses wait for this operator.
    this.arbiter.beginManualControl(session.sessionId, session.ownerId)
    await this.assertConfiguredOutput(session.route)

    const current = this.openValvePairId
    if (current && current.startsWith('manual:')) {
      await this.preemptTimedPulse(current)
    } else if (current && !current.startsWith('hold:')) {
      await this.preemptAutomaticPulse(current)
    }
    if (this.openValvePairId && this.openValvePairId !== `hold:${session.sessionId}`) {
      throw new HoldError(`The active valve ${this.openValvePairId} did not confirm closed`, 'failed')
    }
    this.openValvePairId = `hold:${session.sessionId}`
  }

  /** Closes an automatic pulse through its normal closure path so manual control can begin. */
  private async preemptAutomaticPulse(pairId: string): Promise<void> {
    const activePulse = this.wateringPulseLedger.activePulse()
    const [sensorId, valveId] = pairId.split('-')
    const pairing = this.pairingService.getPairing(sensorId, valveId)
    const closeTarget: ActiveAutomaticPulse = activePulse?.pairId === pairId
      ? activePulse
      : {
          pairId,
          relayAddress: Number(pairing?.Valve?.relayAddress),
          address: Number(pairing?.Valve?.address),
          startedAt: Date.now(),
        }
    try {
      await this.closeAutomaticPulseWithFallback(closeTarget)
    } catch (error) {
      this.arbiter.recordFault(`automatic valve ${pairId} close unconfirmed during manual takeover`, 'close_failed')
      throw new HoldError(`Automatic valve ${pairId} did not confirm closed; check the outlet`, 'failed')
    }
    if (activePulse?.pairId === pairId) await this.wateringPulseLedger.completeActive(pairId)
    if (pairing) pairing.valveOpened = false
    if (this.openValvePairId === pairId) this.openValvePairId = null
    this.lastValveClosedAt = Date.now()
    try {
      await this.apiService.postData(API_ENDPOINTS.LOGS, {
        level: 'warn',
        message: `Automatic valve ${pairId} closed early: an operator took manual control`,
        source: 'StateMachine',
      })
    } catch (error) {
      console.error('Manual takeover log write failed', error)
    }
  }

  /** Ends a timed pulse (autocalibration or bounded manual_water) early and records why. */
  private async preemptTimedPulse(ownerKey: string): Promise<void> {
    try {
      await this.manualPulseManager.closeActive('preempted_by_manual_hold')
    } catch (error) {
      this.arbiter.recordFault(`timed pulse ${ownerKey} close unconfirmed during manual takeover`, 'close_failed')
      throw new HoldError('A timed pulse did not confirm closed; check the outlet', 'failed')
    }
    if (this.openValvePairId === ownerKey) this.openValvePairId = null
    this.lastValveClosedAt = Date.now()
  }

  private openManualHold(session: HoldSession): void {
    if (this.openValvePairId !== `hold:${session.sessionId}`) throw new Error('Manual hold does not own the output')
    const { column, pin } = this.valveService.calculateColumnAndPin(session.route.address)
    this.valveService.operateValve(session.route.relayAddress, column, pin, 'OPEN')
    // A paired pot that was watered by hand follows the normal settling rules before
    // automatic irrigation may water it again.
    const pairing = this.pairingService.getAllPairings().find((item) =>
      Number(item.Valve?.relayAddress) === session.route.relayAddress && Number(item.Valve?.address) === session.route.address)
    if (pairing) recordValveOpen(pairing, Date.now(), DEFAULT_TIMING.WATERING_SETTLE_WINDOW)
  }

  private async closeManualHold(session: HoldSession): Promise<void> {
    // A session must never close a different session's valve.
    if (this.openValvePairId && this.openValvePairId !== `hold:${session.sessionId}`) return
    const { column, pin } = this.valveService.calculateColumnAndPin(session.route.address)
    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.valveService.operateValve(session.route.relayAddress, column, pin, 'CLOSE')
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    // Same fallback as automatic pulses. If it also fails the hold keeps the output, so
    // nothing else can open while the manager keeps retrying the close.
    try {
      this.valveService.closeAllValves()
      return
    } catch (error) {
      lastError = error
    }
    throw lastError instanceof Error ? lastError : new Error('manual hold close failed')
  }

  private releaseManualHold(session: HoldSession, reason: EndReason): void {
    if (this.openValvePairId === `hold:${session.sessionId}`) {
      this.openValvePairId = null
      this.lastValveClosedAt = Date.now()
    }
    this.arbiter.endManualControl(session.sessionId)
    if (reason !== 'released' && reason !== 'stopped_before_start') {
      console.warn(`Manual hold ${session.sessionId} ended: ${reason}`)
    }
  }

  /** Recorded outcome of one timed pulse, for the executor's truthful completion report. */
  manualPulseStatus(pulseId: string) {
    return this.manualPulseManager.priorResult(pulseId)
  }

  async holdManualValve(action: HoldAction, body: any) {
    const enabled = process.env.EXACTH2O_MANUAL_HOLD_ENABLED === '1'
    if (!enabled && action !== 'stop' && action !== 'status') {
      throw new HoldError('Hold-to-water is not commissioned on this controller', 'unavailable')
    }
    const signal: HoldSignal = {
      sessionId: String(body?.sessionId || ''),
      ownerId: String(body?.ownerId || ''),
      sequence: Number(body?.sequence),
      expiresAt: Number(body?.expiresAt),
      route: {
        relayAddress: Number(body?.relayAddress),
        address: Number(body?.address),
        kind: body?.destinationKind === 'solenoid' ? 'solenoid' : 'pot',
        label: typeof body?.label === 'string' ? body.label.slice(0, 80) : undefined,
      },
      takeover: body?.takeover === true,
    }
    const result = await this.manualHoldManager.request(action, signal)
    const arbiter = this.arbiter.snapshot()
    return {
      ...result,
      ready: result.ready && !this.arbiter.fault,
      available: enabled,
      fault: this.arbiter.fault ? this.arbiter.fault.reason : undefined,
      configRewrite: Boolean(arbiter.configRewrite),
      automaticSuspended: Boolean(arbiter.manualControl) || arbiter.manualSettlingForMs > 0,
    }
  }

  /** Read-only snapshot for the independent valve watchdog and diagnostics. */
  getArbiterStatus() {
    const now = Date.now()
    const owner = this.openValvePairId
    let kind: 'automatic' | 'pulse' | 'hold' | null = null
    let deadlineInMs: number | null = null
    if (owner?.startsWith('hold:')) {
      kind = 'hold'
      deadlineInMs = this.manualHoldManager.snapshot().active?.remainingMs ?? 0
    } else if (owner?.startsWith('manual:')) {
      kind = 'pulse'
      deadlineInMs = this.manualPulseManager.remainingMilliseconds()
    } else if (owner) {
      kind = 'automatic'
      const [sensorId, valveId] = owner.split('-')
      const pairing = this.pairingService.getPairing(sensorId, valveId)
      deadlineInMs = pairing?.nextTransitionTime != null ? Math.max(0, pairing.nextTransitionTime - now) : null
    }
    return {
      ok: true,
      state: MachineState[this.state],
      monotonicMs: monotonicMs(),
      owner: owner ? { key: owner, kind, deadlineInMs } : null,
      holds: this.manualHoldManager.snapshot(),
      arbiter: this.arbiter.snapshot(),
      watchdogReconciled: this.watchdogReconciled,
    }
  }

  beginConfigRewrite(id: string, ttlMs: number) {
    const decision = this.arbiter.beginConfigRewrite(id, ttlMs)
    if (decision.allowed && this.manualHoldManager.snapshot().active) {
      // A hold that has not reached manual control yet still owns the session slot.
      this.arbiter.endConfigRewrite(id)
      return { allowed: false as const, reason: 'manual watering is in progress; release it before changing the topology', retryInMs: 2_000 }
    }
    return decision
  }

  endConfigRewrite(id: string) {
    this.arbiter.endConfigRewrite(id)
  }

  /** The independent watchdog forced every output off. Nothing opens until reconciled. */
  recordWatchdogTrip(reason: string) {
    this.watchdogReconciled = false
    this.arbiter.recordFault(`valve watchdog: ${reason}`, 'watchdog')
  }

  /** After an operator confirms every outlet is closed: close all again, then clear faults. */
  async reconcileValveFault(note: string) {
    if (this.manualHoldManager.snapshot().active) throw new Error('A manual hold is still active')
    if (this.manualPulseManager.hasActivePulse()) throw new Error('A timed pulse is still active')
    this.valveService.closeAllValves()
    const automatic = this.wateringPulseLedger.activePulse()
    if (automatic) await this.wateringPulseLedger.completeActive(automatic.pairId)
    this.openValvePairId = null
    this.lastValveClosedAt = Date.now()
    this.arbiter.clearFault()
    this.manualHoldManager.reconcileFault()
    this.watchdogReconciled = true
    try {
      await this.apiService.postData(API_ENDPOINTS.LOGS, { level: 'warn', message: `Valve fault reconciled: ${note.slice(0, 300)}`, source: 'StateMachine' })
    } catch (error) {
      console.error('Reconciliation log write failed', error)
    }
    return this.getArbiterStatus()
  }

  async pulseManualValve(request: ManualPulseRequest): Promise<ManualPulseResult> {
    const manualKey = `manual:${request.pulseId}`
    // A replay of a pulse that already ran is answered from its record, whatever else is happening.
    const prior = this.manualPulseManager.priorResult(request.pulseId)
    if (prior) return prior
    const decision = this.arbiter.timedPulse()
    if (!decision.allowed) throw new Error(`timed pulse refused: ${decision.reason}`)
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
      this.lastValveClosedAt = Date.now()
    }
  }

  private operateAutomaticPulseValve(
    request: ActiveAutomaticPulse,
    state: 'OPEN' | 'CLOSE',
  ): void {
    const { column, pin } = this.valveService.calculateColumnAndPin(request.address)
    this.valveService.operateValve(request.relayAddress, column, pin, state)
  }

  private async closeAutomaticPulseWithFallback(request: ActiveAutomaticPulse): Promise<void> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.operateAutomaticPulseValve(request, 'CLOSE')
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    try {
      this.valveService.closeAllValves()
      return
    } catch (error) {
      lastError = error
    }
    throw lastError instanceof Error ? lastError : new Error('automatic pulse close failed')
  }

  async setState(state: MachineState): Promise<void> {
    console.log(`StateMachine state transition requested: ${MachineState[state]}`)

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

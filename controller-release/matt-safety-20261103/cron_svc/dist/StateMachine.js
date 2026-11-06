"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ManualHoldManager_1 = require("./services/ManualHoldManager");
const ValveArbiter_1 = require("./services/ValveArbiter");
const types_1 = require("./types");
const ApiService_1 = require("./services/ApiService");
const PairingService_1 = require("./services/PairingService");
const ValveService_1 = require("./services/ValveService");
const SensorService_1 = require("./services/SensorService");
const RulesEngineService_1 = require("./services/RulesEngineService");
const BullQueueService_1 = require("./services/BullQueueService");
const constants_1 = require("./config/constants");
const ManualPulseManager_1 = require("./services/ManualPulseManager");
const WateringPulseLedger_1 = require("./services/WateringPulseLedger");
const WateringSafety_1 = require("./services/WateringSafety");
/**
 * Refactored StateMachine that orchestrates the various services
 * to manage the irrigation system state and operations
 */
class StateMachine {
    constructor(apiURL, standardDelayTime = constants_1.DEFAULT_TIMING.STANDARD_DELAY) {
        this.state = types_1.MachineState.STOPPED;
        this.openValvePairId = null;
        this.lastValveClosedAt = null;
        this.valveWakeInProgress = false;
        this.valveWakeStopped = false;
        this.watchdogReconciled = false;
        this.valveInventory = null;
        console.log('Setting up StateMachine');
        // Initialize services
        this.apiService = new ApiService_1.ApiService(apiURL);
        this.pairingService = new PairingService_1.PairingService(this.apiService, standardDelayTime);
        this.valveService = new ValveService_1.ValveService(this.apiService);
        this.sensorService = new SensorService_1.SensorService(this.apiService);
        this.rulesEngineService = new RulesEngineService_1.RulesEngineService();
        this.eventQueueService = new BullQueueService_1.BullQueueService();
        this.manualPulseManager = new ManualPulseManager_1.ManualPulseManager(process.env.MANUAL_PULSE_STATE_FILE || '/app/config/manual-pulses.json', (request) => this.operateManualPulseValve(request, 'OPEN'), (request) => this.operateManualPulseValve(request, 'CLOSE'), () => this.valveService.closeAllValves(), Number(process.env.MANUAL_PULSE_MAX_MILLISECONDS || 60000), Number(process.env.MANUAL_PULSE_MAX_COMMAND_VALVE_MILLISECONDS || 120000));
        this.arbiter = new ValveArbiter_1.ValveArbiter(ValveArbiter_1.monotonicMs, Number(process.env.MANUAL_HOLD_SETTLE_MS || 60000), Number(process.env.MANUAL_HOLD_PULSE_QUIET_MS || 120000));
        const maxContinuous = Number(process.env.EXACTH2O_VALVE_MAX_CONTINUOUS_ON_MS || 0);
        this.manualHoldManager = new ManualHoldManager_1.ManualHoldManager(process.env.MANUAL_HOLD_STATE_FILE || '/app/config/manual-holds.json', {
            acquire: (session) => this.acquireForHold(session),
            open: (session) => this.openManualHold(session),
            close: (session) => this.closeManualHold(session),
            release: (session, reason) => this.releaseManualHold(session, reason),
            onFault: (session, error) => this.arbiter.recordFault(`hold ${session.sessionId} close unconfirmed: ${error instanceof Error ? error.message : String(error)}`, 'close_failed'),
        }, {
            leaseMs: Number(process.env.MANUAL_HOLD_LEASE_MS || 2500),
            // No continuous-on cap is imposed unless the valve/supply ratings call for one.
            maxContinuousMs: Number.isFinite(maxContinuous) && maxContinuous > 0 ? maxContinuous : null,
        });
        this.wateringPulseLedger = new WateringPulseLedger_1.WateringPulseLedger(process.env.AUTOMATIC_PULSE_LEDGER_PATH || '/app/config/automatic-pulses.json');
        // Set up event processing
        this.eventQueueService.setEventProcessor(this.processStateTransition.bind(this));
        // Initialize valve configurations
        const valveBoardConfigs = this.valveService.getValveBoardConfigs(true);
        this.valveService.setBoardConfigs(valveBoardConfigs.length > 0 ? valveBoardConfigs : constants_1.DEFAULT_BOARD_CONFIGS, true);
    }
    async init(initializeHardware = true, assignAddresses = false) {
        console.log('Initializing StateMachine');
        this.state = types_1.MachineState.STARTUP;
        const valveBoardConfigs = this.valveService.getValveBoardConfigs(initializeHardware);
        await this.valveService.setBoardConfigs(valveBoardConfigs.length > 0 ? valveBoardConfigs : constants_1.DEFAULT_BOARD_CONFIGS, true);
        // A previous process may have died while a manual pulse was active. Close
        // that valve before loading pairings or entering RUNNING state.
        await this.manualPulseManager.recover();
        await this.manualHoldManager.recover();
        // Give the shared supply the same recovery time after startup close-all as
        // it receives between normal automatic pulses.
        this.lastValveClosedAt = Date.now();
        // Automatic watering remains fail-closed until the durable per-pot pulse
        // ledger has been restored. Keep sensing alive if the ledger is damaged;
        // later watering attempts will be rejected because it is uninitialized.
        let automaticLedgerReady = false;
        try {
            await this.wateringPulseLedger.init();
            automaticLedgerReady = true;
        }
        catch (error) {
            console.error('Automatic watering disabled: durable pulse ledger could not be restored', error);
        }
        if (automaticLedgerReady) {
            const activePulse = this.wateringPulseLedger.activePulse();
            if (activePulse) {
                console.warn(`Recovering automatic valve left active by a previous process: ${activePulse.pairId}`);
                await this.closeAutomaticPulseWithFallback(activePulse);
                await this.wateringPulseLedger.completeActive(activePulse.pairId);
                this.openValvePairId = null;
                this.lastValveClosedAt = Date.now();
            }
        }
        if (initializeHardware) {
            console.log('First time hardware initialization');
            await this.valveService.setupValveConfigs();
            await this.sensorService.setupSensorConfigs(assignAddresses);
        }
        console.log('Setup configurations for valves');
        await this.pairingService.fetchPairings();
        console.log('Fetched pairings from API');
        console.log(`Total pairings fetched: ${this.pairingService.getAllPairings().length}`);
        console.log('Setting state to RUNNING');
        this.state = types_1.MachineState.RUNNING;
        console.log('StateMachine initialized');
    }
    async start() {
        console.log('Starting StateMachine');
        // A hold may be running while the controller is STOPPED. End it before the
        // shared valve lock is reset, so automatic watering cannot open a second valve.
        await this.manualHoldManager.stopAll();
        this.openValvePairId = null;
        this.eventQueueService.setLoadingPairings(true);
        // Ensure we start from a clean slate of pairings to prevent stale entries lingering
        console.log('Clearing existing in-memory pairings before startup/reload...');
        this.pairingService.clearPairings();
        console.log('Fetching pairings from API...');
        await this.pairingService.fetchPairings();
        console.log('🔍 Checking sensor health before starting pairings...');
        const sensorsHealthy = await this.sensorService.checkSensorHealth();
        if (!sensorsHealthy) {
            console.warn('⚠️  Sensor health check failed - forcing immediate sensor setup during startup');
            const setupSuccess = await this.sensorService.setupSensorConfigs(false);
            if (!setupSuccess) {
                console.error('❌ Forced sensor setup failed - pairings may not work correctly');
            }
            else {
                console.log('✅ Forced sensor setup completed successfully');
            }
        }
        else {
            console.log('✅ Sensor health check completed successfully');
        }
        // Clear queue BEFORE scheduling new initial transitions to avoid race
        console.log('clearing queue before startup...');
        await this.eventQueueService.clearQueue();
        console.log('📋 Starting pairings after sensor health verification...');
        for (const pairing of this.pairingService.getAllPairings()) {
            console.log(`Starting pairing: ${pairing.sensorId}-${pairing.valveId}`);
            // Start each pairing in STARTUP so rule STARTUP->MEASURING can fire
            await this.startPairing(pairing.sensorId, pairing.valveId, 'STARTUP');
        }
        this.eventQueueService.setLoadingPairings(false);
        console.log('Starting event loop');
        this.valveWakeStopped = false;
        this.runEventLoop();
    }
    // Default state changed to STARTUP; now async so callers can await queue scheduling
    async startPairing(sensorId, valveId, state = 'STARTUP', nextTransitionTime = null) {
        var _a;
        const pairing = this.pairingService.getPairing(sensorId.toString(), valveId.toString());
        if (pairing) {
            // If pairing already persisted in non-STARTUP state, honor it (skip forcing STARTUP)
            const initialState = (_a = pairing.state) !== null && _a !== void 0 ? _a : 'STARTUP';
            const desiredState = initialState !== 'STARTUP' && state === 'STARTUP'
                ? initialState
                : state;
            pairing.nextTransitionTime = nextTransitionTime !== null && nextTransitionTime !== void 0 ? nextTransitionTime : Date.now();
            console.log(`Starting pairing: ${sensorId}-${valveId} with nextState ${desiredState}, nextTransitionTime: ${pairing.nextTransitionTime}`);
            await this.eventQueueService.queueStateTransition(pairing, desiredState);
        }
    }
    runEventLoop() {
        console.log('*');
        this.state = types_1.MachineState.RUNNING;
        this.eventQueueService.processQueue();
    }
    async stopEventLoop() {
        this.valveWakeStopped = true;
        if (this.valveWakeTimer)
            clearTimeout(this.valveWakeTimer);
        this.valveWakeTimer = undefined;
        // Close hardware before logs or queue shutdown can block.
        this.valveService.closeAllValves();
        await this.manualHoldManager.stopAll();
        console.log('Stopping StateMachine event queue...');
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `Stopping StateMachine event queue`,
            source: 'StateMachine'
        });
        await this.eventQueueService.stop();
        console.log('StateMachine event queue stopped.');
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `StateMachine event queue stopped`,
            source: 'StateMachine'
        });
        // close all valves
        console.log('Closing all valves as part of stopping StateMachine...');
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `Closing all valves as part of stopping StateMachine`,
            source: 'StateMachine'
        });
        // STOPPED cancels the queued close transition. Retire its active marker
        // only after close-all succeeds; retain the per-pot pulse history/limits.
        const activePulse = this.wateringPulseLedger.activePulse();
        if (activePulse) {
            await this.wateringPulseLedger.completeActive(activePulse.pairId);
        }
        this.openValvePairId = null;
        this.lastValveClosedAt = Date.now();
        console.log('All valves closed.');
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `All valves closed`,
            source: 'StateMachine'
        });
        this.state = types_1.MachineState.STOPPED;
        console.log('StateMachine stopped.');
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `StateMachine stopped`,
            source: 'StateMachine'
        });
    }
    async shutdown() {
        console.log('Shutting down StateMachine...');
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `Shutting down StateMachine`,
            source: 'StateMachine'
        });
        await this.manualPulseManager.closeActive();
        await this.stopEventLoop();
        await this.eventQueueService.close();
        console.log('StateMachine shutdown complete');
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `StateMachine shutdown complete`,
            source: 'StateMachine'
        });
    }
    async processStateTransition(event) {
        const { pairing, newState } = event;
        console.log(`[PROCESS] Executing transition job for ${pairing.sensorId}-${pairing.valveId}: current=${pairing.state} queued=${newState} at ${new Date().toISOString()}`);
        const wasWaiting = Number.isSafeInteger(pairing.valveWaitOrder);
        await this.checkRulesForPair(pairing, newState);
        // A rejected/stale head must hand off too, not leave the next request asleep.
        if (wasWaiting || Number.isSafeInteger(pairing.valveWaitOrder) || newState === 'VALVE_OPEN') {
            await this.wakeNextValveWaiter();
        }
    }
    scheduleValveWake(delay) {
        if (this.valveWakeStopped || this.state !== types_1.MachineState.RUNNING)
            return;
        if (this.valveWakeTimer)
            clearTimeout(this.valveWakeTimer);
        this.valveWakeTimer = setTimeout(() => {
            this.valveWakeTimer = undefined;
            void this.wakeNextValveWaiter();
        }, Math.max(1, delay));
        this.valveWakeTimer.unref();
    }
    async wakeNextValveWaiter() {
        var _a;
        if (this.valveWakeStopped || this.state !== types_1.MachineState.RUNNING || this.openValvePairId || this.valveWakeInProgress)
            return;
        const arbitration = (_a = this.arbiter) === null || _a === void 0 ? void 0 : _a.automaticOpen();
        if (arbitration && !arbitration.allowed) {
            if (arbitration.retryInMs != null)
                this.scheduleValveWake(arbitration.retryInMs);
            return;
        }
        const remainingRecovery = this.lastValveClosedAt == null ? 0
            : this.lastValveClosedAt + constants_1.DEFAULT_TIMING.VALVE_RECOVERY_DELAY - Date.now();
        if (remainingRecovery > 0) {
            this.scheduleValveWake(remainingRecovery);
            return;
        }
        this.valveWakeInProgress = true;
        try {
            await this.eventQueueService.wakeNextValveWaiter();
        }
        catch (error) {
            // Notification failure must never turn a successful physical close into a
            // failed-close state. Delayed Bull jobs also retain their timed fallback.
            console.error('Valve queue wake-up failed; retaining timed retry', error);
            this.scheduleValveWake(constants_1.DEFAULT_TIMING.VALVE_CONFLICT_RETRY_DELAY);
        }
        finally {
            this.valveWakeInProgress = false;
        }
    }
    async queueNextTransition(pairing, nextState) {
        if (nextState !== 'DELAY')
            delete pairing.valveWaitOrder;
        await this.eventQueueService.queueStateTransition(pairing, nextState);
    }
    async checkRulesForPair(pairing, newState) {
        var _a;
        const pairId = `${pairing.sensorId}-${pairing.valveId}`;
        pairing.state = newState;
        const currentState = pairing.state;
        const currentTime = Date.now();
        const measurementFresh = (0, WateringSafety_1.isFreshMeasurement)(pairing, currentTime, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE);
        const wateringShouldOpen = (pairing.wateringMeasurementValid &&
            measurementFresh &&
            (0, WateringSafety_1.shouldAttemptWatering)(pairing, currentTime, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, constants_1.DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT));
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
            wateringEnabled: (0, WateringSafety_1.isWateringConfigEnabled)(pairing),
            wateringMeasurementValid: pairing.wateringMeasurementValid && measurementFresh,
            wateringShouldOpen,
            currentTime,
        };
        const { events } = await this.rulesEngineService.evaluateRules(facts);
        if (events.length === 0) {
            await this.queueNextTransition(pairing, newState);
        }
        else {
            let finalState = newState;
            // Process all state transitions but only queue the final one
            for (const event of events) {
                const nextState = (_a = event.params) === null || _a === void 0 ? void 0 : _a.newState;
                const handledState = await this.handleStateTransition(pairing, nextState, pairId);
                console.log(`${new Date()}) Transitioning to new state: ${pairId} [ ${currentState} => ${nextState} ] ${pairing.nextTransitionTime - Date.now()}`);
                finalState = handledState !== null && handledState !== void 0 ? handledState : nextState;
            }
            // Only queue the final state transition to prevent out-of-order execution
            await this.queueNextTransition(pairing, finalState);
        }
    }
    async handleStateTransition(pairing, nextState, pairId) {
        switch (nextState) {
            case 'MEASURING':
                await this.handleMeasuringState(pairing, pairId);
                return nextState;
            case 'DELAY':
                await this.handleDelayState(pairing, pairId);
                return nextState;
            case 'VALVE_OPEN':
                return await this.handleValveOpenState(pairing, pairId);
            case 'VALVE_CLOSE':
                return await this.handleValveCloseState(pairing, pairId);
            case 'IDLE':
                await this.handleIdleState(pairing, pairId);
                return nextState;
            case 'DISABLED':
                await this.handleDisabledState(pairing, pairId);
                return nextState;
            case 'SENSOR_FAULT':
                await this.handleSensorFaultState(pairing, pairId);
                return nextState;
            default:
                return null;
        }
    }
    async handleMeasuringState(pairing, pairId) {
        var _a;
        pairing.previousWTCPercentMeasured = (0, WateringSafety_1.isFiniteNumber)(pairing.WTCPercentMeasured)
            ? pairing.WTCPercentMeasured
            : null;
        pairing.previousMeasurementAt = (0, WateringSafety_1.isFiniteNumber)(pairing.lastMeasurementAt)
            ? pairing.lastMeasurementAt
            : null;
        pairing.measurementValid = false;
        pairing.wateringMeasurementValid = false;
        pairing.WTCPercentMeasured = null;
        pairing.lastMeasurementAt = null;
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `Measuring phase: ${pairId}`,
            source: 'StateMachine'
        });
        console.log(`Measuring: ${pairId}`);
        try {
            const allData = await this.sensorService.operateSensor(pairing.Sensor.boardSerialId, pairing.Sensor.address);
            if (allData === null || allData.length === 0) {
                console.error(`No data received from sensor ${pairing.Sensor.address} on board ${pairing.Sensor.boardSerialId}`);
                throw new Error(`No data received from sensor ${pairing.Sensor.address} on board ${pairing.Sensor.boardSerialId}`);
            }
            const data = allData[0];
            const rawValue = Number(data === null || data === void 0 ? void 0 : data.volumetricWaterContent);
            if (!(0, WateringSafety_1.isFiniteNumber)(rawValue)) {
                throw new Error(`Invalid raw water content from sensor ${pairing.Sensor.address} on board ${pairing.Sensor.boardSerialId}: ${data === null || data === void 0 ? void 0 : data.volumetricWaterContent}`);
            }
            const coefficientsString = ((_a = pairing.Calibration) === null || _a === void 0 ? void 0 : _a.polynomialCoefficientsCommaDelimited) || '0,1';
            const calibratedValue = this.sensorService.calibrateRawData(coefficientsString, rawValue);
            if (!(0, WateringSafety_1.isFiniteNumber)(calibratedValue)) {
                throw new Error(`Invalid calibrated water content for ${pairId}: ${calibratedValue}`);
            }
            pairing.WTCPercentMeasured = calibratedValue;
            pairing.measurementValid = true;
            pairing.wateringMeasurementValid = (0, WateringSafety_1.hasCalibration)(pairing) && (0, WateringSafety_1.isPercentValue)(calibratedValue);
            pairing.lastMeasurementAt = Date.now();
            const wateringBand = (0, WateringSafety_1.getWateringBand)(pairing, constants_1.DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, constants_1.DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT);
            if ((0, WateringSafety_1.isWateringConfigEnabled)(pairing) &&
                pairing.wateringMeasurementValid &&
                calibratedValue >= wateringBand.recoveryMax) {
                (0, WateringSafety_1.resetWateringWindow)(pairing);
            }
            const temperatureData = data === null || data === void 0 ? void 0 : data.temperature;
            const electricalConductivityData = data === null || data === void 0 ? void 0 : data.electricalConductivity;
            console.log(`Coefficients: ${coefficientsString}, Raw value: ${rawValue}, Calibrated value: ${calibratedValue} for sensor ${pairing.Sensor.address} pairing ${pairId}`);
            console.log(`Sending Calibrated value: ${calibratedValue}, Raw value: ${rawValue} for sensor ${pairing.Sensor.address}/pairing ${pairId}`);
            await this.apiService.postData(constants_1.API_ENDPOINTS.READINGS, {
                sensorId: pairing.sensorId,
                rawValue,
                calibratedValue,
                temperature: temperatureData,
                electricalConductivity: electricalConductivityData
            });
            await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                level: 'info',
                message: `Measured: ${pairId}: ${pairing.Sensor.boardSerialId}:${pairing.Sensor.address}. Calibrated value: ${calibratedValue}, Raw value: ${rawValue}, Temperature: ${temperatureData}, Electrical Conductivity: ${electricalConductivityData}`,
                source: 'StateMachine'
            });
            if ((0, WateringSafety_1.isWateringConfigEnabled)(pairing) &&
                pairing.wateringMeasurementValid &&
                calibratedValue < wateringBand.floor) {
                await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                    level: 'warn',
                    message: `FLOOR_BREACH: ${pairId}; measured=${calibratedValue.toFixed(2)} floor=${wateringBand.floor.toFixed(2)} trigger=${wateringBand.trigger.toFixed(2)} recovery=${wateringBand.recoveryMax.toFixed(2)} pulseCount=${pairing.wateringWindowPulseCount}`,
                    source: 'StateMachine'
                });
            }
            if ((0, WateringSafety_1.isWateringConfigEnabled)(pairing) && !pairing.wateringMeasurementValid) {
                await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                    level: 'error',
                    message: `Watering measurement rejected for ${pairId}: calibrated value is not a valid 0-100 percent reading`,
                    source: 'StateMachine'
                });
            }
        }
        catch (error) {
            console.error('Error getting sensor data:', error);
            pairing.measurementValid = false;
            pairing.wateringMeasurementValid = false;
            pairing.WTCPercentMeasured = null;
            pairing.lastMeasurementAt = null;
            await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                level: 'error',
                message: `Error getting sensor data: ${pairId}; watering blocked until a fresh valid reading succeeds`,
                source: 'StateMachine'
            });
            pairing.nextTransitionTime = Date.now();
            return;
        }
        pairing.nextTransitionTime = Date.now() + pairing.timingRules.measurementTime;
    }
    async handleDelayState(pairing, pairId) {
        pairing.nextTransitionTime = Date.now() + pairing.timingRules.delayTime;
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `Delay phase for: ${pairId}`,
            source: 'StateMachine'
        });
    }
    async handleValveOpenState(pairing, pairId) {
        var _a;
        try {
            const livePairing = await this.getLivePairing(pairing);
            if (!livePairing) {
                await this.logValveOpenBlocked(pairId, 'pairing no longer exists or API re-check failed');
                pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime;
                return 'IDLE';
            }
            this.applyLivePairingConfig(pairing, livePairing);
            const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(pairing, Date.now(), constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY, constants_1.DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, constants_1.DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT);
            if (!decision.allowed) {
                await this.logValveOpenBlocked(pairId, decision.reason || 'safety guard rejected valve open', decision.normalHold ? 'info' : 'error');
                pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime;
                return decision.fault ? 'SENSOR_FAULT' : 'IDLE';
            }
            // Admission order belongs to eligible watering requests, not sensor jobs.
            // Retain this ticket across retries and Bull worker reconnections.
            await this.eventQueueService.registerValveWaiter(pairing);
            const earlierWaiter = await this.eventQueueService.hasEarlierValveWaiter(pairing);
            const arbitration = this.arbiter ? this.arbiter.automaticOpen() : { allowed: true };
            if (!arbitration.allowed) {
                // Manual troubleshooting, its settling window, a topology rewrite or a valve
                // fault takes priority. Retry later without changing any saved setting.
                const retryDelay = (_a = arbitration.retryInMs) !== null && _a !== void 0 ? _a : pairing.timingRules.intervalTime;
                await this.logValveOpenBlocked(pairId, `${arbitration.reason}; retrying in ${Math.round(retryDelay)}ms`, 'info');
                pairing.nextTransitionTime = Date.now() + retryDelay;
                return arbitration.retryInMs == null ? 'IDLE' : 'DELAY';
            }
            if (this.openValvePairId && this.openValvePairId !== pairId) {
                await this.logValveOpenBlocked(pairId, `another valve is already open: ${this.openValvePairId}; retrying in ${constants_1.DEFAULT_TIMING.VALVE_CONFLICT_RETRY_DELAY}ms`, 'info');
                pairing.nextTransitionTime = Date.now() + constants_1.DEFAULT_TIMING.VALVE_CONFLICT_RETRY_DELAY;
                return 'DELAY';
            }
            if (earlierWaiter) {
                pairing.nextTransitionTime = Date.now() + constants_1.DEFAULT_TIMING.VALVE_CONFLICT_RETRY_DELAY;
                return 'DELAY';
            }
            const now = Date.now();
            if (constants_1.DEFAULT_TIMING.VALVE_RECOVERY_DELAY > 0 &&
                (0, WateringSafety_1.isFiniteNumber)(this.lastValveClosedAt) &&
                now - this.lastValveClosedAt < constants_1.DEFAULT_TIMING.VALVE_RECOVERY_DELAY) {
                const retryDelay = constants_1.DEFAULT_TIMING.VALVE_RECOVERY_DELAY - (now - this.lastValveClosedAt);
                await this.logValveOpenBlocked(pairId, `shared water supply is recovering; retrying in ${retryDelay}ms`, 'info');
                pairing.nextTransitionTime = now + retryDelay;
                return 'DELAY';
            }
            let durablePulse;
            try {
                durablePulse = await this.wateringPulseLedger.reserve(pairId, now, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY);
            }
            catch (error) {
                await this.logValveOpenBlocked(pairId, `durable pulse ledger unavailable; watering failed closed: ${error}`, 'error');
                pairing.nextTransitionTime = now + pairing.timingRules.intervalTime;
                return 'IDLE';
            }
            if (!durablePulse.allowed) {
                await this.logValveOpenBlocked(pairId, `durable per-pot ${durablePulse.reason} guard active; count=${durablePulse.pulseCount} retryAt=${durablePulse.retryAt ? new Date(durablePulse.retryAt).toISOString() : 'unknown'}`, 'info');
                pairing.nextTransitionTime = now + pairing.timingRules.intervalTime;
                return 'IDLE';
            }
            const boardConfigAddress = Number(pairing.Valve.relayAddress);
            const address = Number(pairing.Valve.address);
            const activePulse = await this.wateringPulseLedger.beginActive(pairId, boardConfigAddress, address, Date.now());
            // Awaited ledger operations allow a hold/stop to acquire the controller.
            // Recheck and acquire immediately before OPEN, without an intervening await.
            const finalAdmission = this.arbiter ? this.arbiter.automaticOpen() : { allowed: true };
            if (this.valveWakeStopped || !finalAdmission.allowed || (this.openValvePairId && this.openValvePairId !== pairId)) {
                await this.wateringPulseLedger.completeActive(pairId);
                pairing.nextTransitionTime = Date.now() + constants_1.DEFAULT_TIMING.VALVE_CONFLICT_RETRY_DELAY;
                return 'DELAY';
            }
            this.openValvePairId = pairId;
            pairing.valveOpened = true;
            pairing.nextTransitionTime = Date.now() + pairing.timingRules.valveOpenTime;
            this.operateAutomaticPulseValve(activePulse, 'OPEN');
            void this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                level: 'info', message: `Valve open phase: ${pairId}`, source: 'StateMachine'
            }).catch(error => console.error('Valve-open log failed:', error));
            (0, WateringSafety_1.recordValveOpen)(pairing, Date.now(), constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW);
            console.log(`Valve ${pairId} opened successfully`);
            try {
                void this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                    level: 'info',
                    message: `Opened Valve: ${pairId}; measured=${(0, WateringSafety_1.isFiniteNumber)(pairing.WTCPercentMeasured) ? pairing.WTCPercentMeasured.toFixed(2) : 'unknown'} floor=${(0, WateringSafety_1.getWateringBand)(pairing, constants_1.DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, constants_1.DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT).floor.toFixed(2)} trigger=${(0, WateringSafety_1.getWateringBand)(pairing, constants_1.DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, constants_1.DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT).trigger.toFixed(2)} recovery=${(0, WateringSafety_1.getWateringBand)(pairing, constants_1.DEFAULT_TIMING.WATERING_TRIGGER_OFFSET_PERCENT, constants_1.DEFAULT_TIMING.WATERING_RECOVERY_OFFSET_PERCENT).recoveryMax.toFixed(2)} pulseCount=${pairing.wateringWindowPulseCount}`,
                    source: 'StateMachine'
                });
            }
            catch (error) {
                console.error(`Valve ${pairId} opened, but the audit log write failed:`, error);
            }
            return 'VALVE_OPEN';
        }
        catch (error) {
            console.error(`Error opening valve ${pairId}:`, error);
            try {
                await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                    level: 'error',
                    message: `Error opening valve ${pairId}; watering blocked: ${error}`,
                    source: 'StateMachine'
                });
            }
            catch (logError) {
                console.error(`Failed to write valve-open error log for ${pairId}:`, logError);
            }
            const activePulse = this.wateringPulseLedger.activePulse();
            if ((activePulse === null || activePulse === void 0 ? void 0 : activePulse.pairId) === pairId) {
                this.openValvePairId = pairId;
                pairing.valveOpened = true;
                pairing.nextTransitionTime = Date.now() + constants_1.DEFAULT_TIMING.STANDARD_VALVE_CLOSE;
                return 'VALVE_OPEN';
            }
            pairing.valveOpened = false;
            pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime;
            return 'IDLE';
        }
    }
    async handleValveCloseState(pairing, pairId) {
        if (!pairing.valveOpened && this.openValvePairId !== pairId) {
            console.log(`Skipping close for ${pairId}; this scheduler did not open that valve`);
            await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                level: 'info',
                message: `Skipped Valve Close: ${pairId}; valve was not opened by scheduler`,
                source: 'StateMachine'
            });
            pairing.nextTransitionTime = Date.now();
            return 'IDLE';
        }
        pairing.nextTransitionTime = Date.now() + constants_1.DEFAULT_TIMING.STANDARD_VALVE_CLOSE;
        console.log(`Closing valve: ${pairId}`);
        try {
            const activePulse = this.wateringPulseLedger.activePulse();
            const closeTarget = (activePulse === null || activePulse === void 0 ? void 0 : activePulse.pairId) === pairId
                ? activePulse
                : {
                    pairId,
                    relayAddress: Number(pairing.Valve.relayAddress),
                    address: Number(pairing.Valve.address),
                    startedAt: Date.now(),
                };
            await this.closeAutomaticPulseWithFallback(closeTarget);
            if ((activePulse === null || activePulse === void 0 ? void 0 : activePulse.pairId) === pairId) {
                await this.wateringPulseLedger.completeActive(pairId);
            }
            console.log(`Valve ${pairId} closed successfully`);
            this.lastValveClosedAt = Date.now();
            if (this.openValvePairId === pairId) {
                this.openValvePairId = null;
            }
            pairing.valveOpened = false;
            try {
                await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                    level: 'info',
                    message: `Closed Valve: ${pairId}`,
                    source: 'StateMachine'
                });
            }
            catch (error) {
                console.error(`Valve ${pairId} closed, but the audit log write failed:`, error);
            }
            return 'VALVE_CLOSE';
        }
        catch (error) {
            console.error(`Error closing valve ${pairId}:`, error);
            try {
                await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                    level: 'error',
                    message: `Error closing valve ${pairId}; retrying closure before any further watering: ${error}`,
                    source: 'StateMachine'
                });
            }
            catch (logError) {
                console.error(`Failed to write valve-close error log for ${pairId}:`, logError);
            }
            pairing.valveOpened = true;
            this.openValvePairId = pairId;
            pairing.nextTransitionTime = Date.now() + constants_1.DEFAULT_TIMING.STANDARD_VALVE_CLOSE;
            return 'VALVE_OPEN';
        }
    }
    async handleIdleState(pairing, pairId) {
        pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime;
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `Idle/Interval phase : ${pairId}`,
            source: 'StateMachine'
        });
    }
    async handleDisabledState(pairing, pairId) {
        pairing.nextTransitionTime = null;
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'info',
            message: `Disabling: ${pairId}`,
            source: 'StateMachine'
        });
    }
    async handleSensorFaultState(pairing, pairId) {
        pairing.WTCPercentMeasured = null;
        pairing.measurementValid = false;
        pairing.wateringMeasurementValid = false;
        pairing.lastMeasurementAt = null;
        pairing.valveOpened = false;
        pairing.nextTransitionTime = Date.now() + pairing.timingRules.intervalTime;
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level: 'error',
            message: `Sensor fault fail-closed: ${pairId}; no watering until a fresh valid reading succeeds`,
            source: 'StateMachine'
        });
    }
    async getLivePairing(pairing) {
        try {
            return await this.apiService.fetchData(`${constants_1.API_ENDPOINTS.PAIRINGS}/${pairing.sensorId}/${pairing.valveId}`);
        }
        catch (error) {
            console.error(`Failed final pairing re-check for ${pairing.sensorId}-${pairing.valveId}:`, error);
            return null;
        }
    }
    applyLivePairingConfig(pairing, livePairing) {
        pairing.WTCPercentLimit = livePairing.WTCPercentLimit;
        pairing.ValveOpenTime = livePairing.ValveOpenTime;
        pairing.MeasurementInterval = livePairing.MeasurementInterval;
        pairing.Calibration = livePairing.Calibration;
        pairing.timingRules.valveOpenTime = livePairing.ValveOpenTime;
        pairing.timingRules.intervalTime = livePairing.MeasurementInterval;
    }
    async logValveOpenBlocked(pairId, reason, level = 'error') {
        console.warn(`Valve open blocked for ${pairId}: ${reason}`);
        await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
            level,
            message: `Valve open blocked: ${pairId}; ${reason}`,
            source: 'StateMachine'
        });
    }
    // Public API methods
    getPairingState(sensorId, valveId) {
        return this.pairingService.getPairing(sensorId, valveId);
    }
    setPairingState(sensorId, valveId, newState) {
        this.pairingService.setPairingState(sensorId, valveId, newState);
    }
    getAllPairingStates() {
        return this.pairingService.getAllPairings();
    }
    disablePairing(sensorId, valveId) {
        const pairing = this.pairingService.getPairing(sensorId, valveId);
        if (pairing) {
            console.log(`Disabling pairing: ${sensorId}-${valveId}`);
            // Note: Not awaiting here since this is a synchronous public method
            this.eventQueueService.queueStateTransition(pairing, 'DISABLED');
        }
    }
    getBoardConfigs() {
        return this.valveService.getBoardConfigs();
    }
    async setBoardConfigs(boardConfigs, updateAPI = false) {
        return await this.valveService.setBoardConfigs(boardConfigs, updateAPI);
    }
    // ---------------------------------------------------------------- manual hold
    routeKey(relayAddress, address) {
        return `${relayAddress}:${address}`;
    }
    /** The output must exist in the controller's own valve inventory, not just be a plausible address. */
    async assertConfiguredOutput(route) {
        var _a, _b, _c;
        if (!this.valveService.getBoardConfigs().some((board) => board.address === route.relayAddress)) {
            throw new ManualHoldManager_1.HoldError('Valve board unavailable', 'route');
        }
        if (!Number.isInteger(route.address) || route.address < 1 || route.address > constants_1.VALVE_CONFIGURATION.COLS * constants_1.VALVE_CONFIGURATION.ROWS) {
            throw new ManualHoldManager_1.HoldError('Valve channel is outside the board', 'route');
        }
        const fresh = this.valveInventory && Date.now() - this.valveInventory.at < 60000;
        if (!fresh) {
            let valves = [];
            try {
                valves = await this.apiService.fetchData(constants_1.API_ENDPOINTS.VALVES, { timeoutMs: 1500, retries: 0 });
            }
            catch (_d) {
                throw new ManualHoldManager_1.HoldError('Valve inventory unavailable; manual watering cannot be started safely', 'unavailable');
            }
            const keys = new Set();
            for (const valve of Array.isArray(valves) ? valves : []) {
                const relayText = String((_b = (_a = valve === null || valve === void 0 ? void 0 : valve.relayAddress) !== null && _a !== void 0 ? _a : valve === null || valve === void 0 ? void 0 : valve.RelayAddress) !== null && _b !== void 0 ? _b : '').trim();
                const relay = /^0x/i.test(relayText) ? Number.parseInt(relayText, 16) : Number(relayText);
                const address = Number((_c = valve === null || valve === void 0 ? void 0 : valve.address) !== null && _c !== void 0 ? _c : valve === null || valve === void 0 ? void 0 : valve.Address);
                if (Number.isInteger(relay) && Number.isInteger(address))
                    keys.add(this.routeKey(relay, address));
            }
            this.valveInventory = { at: Date.now(), keys };
        }
        if (!this.valveInventory.keys.has(this.routeKey(route.relayAddress, route.address))) {
            throw new ManualHoldManager_1.HoldError('That output is not in the controller valve inventory', 'route');
        }
    }
    /**
     * Coordinated ownership transfer for a hold. Runs synchronously up to the first await,
     * so the arbitration check and the manual-control flag are atomic with respect to
     * every other request this process handles.
     */
    async acquireForHold(session) {
        var _a;
        if (![types_1.MachineState.RUNNING, types_1.MachineState.STOPPED].includes(this.state)) {
            throw new ManualHoldManager_1.HoldError('Controller is not ready for manual watering (starting or reloading)', 'unavailable');
        }
        const decision = this.arbiter.holdStart();
        if (!decision.allowed)
            throw new ManualHoldManager_1.HoldError(`Manual watering unavailable: ${decision.reason}`, 'unavailable');
        if (((_a = this.openValvePairId) === null || _a === void 0 ? void 0 : _a.startsWith('hold:')) && this.openValvePairId !== `hold:${session.sessionId}`) {
            throw new ManualHoldManager_1.HoldError('Another manual hold owns the output', 'busy');
        }
        // From here on automatic starts and timed pulses wait for this operator.
        this.arbiter.beginManualControl(session.sessionId, session.ownerId);
        await this.assertConfiguredOutput(session.route);
        const current = this.openValvePairId;
        if (current && current.startsWith('manual:')) {
            await this.preemptTimedPulse(current);
        }
        else if (current && !current.startsWith('hold:')) {
            await this.preemptAutomaticPulse(current);
        }
        if (this.openValvePairId && this.openValvePairId !== `hold:${session.sessionId}`) {
            throw new ManualHoldManager_1.HoldError(`The active valve ${this.openValvePairId} did not confirm closed`, 'failed');
        }
        this.openValvePairId = `hold:${session.sessionId}`;
    }
    /** Closes an automatic pulse through its normal closure path so manual control can begin. */
    async preemptAutomaticPulse(pairId) {
        var _a, _b;
        const activePulse = this.wateringPulseLedger.activePulse();
        const [sensorId, valveId] = pairId.split('-');
        const pairing = this.pairingService.getPairing(sensorId, valveId);
        const closeTarget = (activePulse === null || activePulse === void 0 ? void 0 : activePulse.pairId) === pairId
            ? activePulse
            : {
                pairId,
                relayAddress: Number((_a = pairing === null || pairing === void 0 ? void 0 : pairing.Valve) === null || _a === void 0 ? void 0 : _a.relayAddress),
                address: Number((_b = pairing === null || pairing === void 0 ? void 0 : pairing.Valve) === null || _b === void 0 ? void 0 : _b.address),
                startedAt: Date.now(),
            };
        try {
            await this.closeAutomaticPulseWithFallback(closeTarget);
        }
        catch (error) {
            this.arbiter.recordFault(`automatic valve ${pairId} close unconfirmed during manual takeover`, 'close_failed');
            throw new ManualHoldManager_1.HoldError(`Automatic valve ${pairId} did not confirm closed; check the outlet`, 'failed');
        }
        if ((activePulse === null || activePulse === void 0 ? void 0 : activePulse.pairId) === pairId)
            await this.wateringPulseLedger.completeActive(pairId);
        if (pairing)
            pairing.valveOpened = false;
        if (this.openValvePairId === pairId)
            this.openValvePairId = null;
        this.lastValveClosedAt = Date.now();
        try {
            await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                level: 'warn',
                message: `Automatic valve ${pairId} closed early: an operator took manual control`,
                source: 'StateMachine',
            });
        }
        catch (error) {
            console.error('Manual takeover log write failed', error);
        }
    }
    /** Ends a timed pulse (autocalibration or bounded manual_water) early and records why. */
    async preemptTimedPulse(ownerKey) {
        try {
            await this.manualPulseManager.closeActive('preempted_by_manual_hold');
        }
        catch (error) {
            this.arbiter.recordFault(`timed pulse ${ownerKey} close unconfirmed during manual takeover`, 'close_failed');
            throw new ManualHoldManager_1.HoldError('A timed pulse did not confirm closed; check the outlet', 'failed');
        }
        if (this.openValvePairId === ownerKey)
            this.openValvePairId = null;
        this.lastValveClosedAt = Date.now();
    }
    openManualHold(session) {
        if (this.openValvePairId !== `hold:${session.sessionId}`)
            throw new Error('Manual hold does not own the output');
        const { column, pin } = this.valveService.calculateColumnAndPin(session.route.address);
        this.valveService.operateValve(session.route.relayAddress, column, pin, 'OPEN');
        // A paired pot that was watered by hand follows the normal settling rules before
        // automatic irrigation may water it again.
        const pairing = this.pairingService.getAllPairings().find((item) => { var _a, _b; return Number((_a = item.Valve) === null || _a === void 0 ? void 0 : _a.relayAddress) === session.route.relayAddress && Number((_b = item.Valve) === null || _b === void 0 ? void 0 : _b.address) === session.route.address; });
        if (pairing)
            (0, WateringSafety_1.recordValveOpen)(pairing, Date.now(), constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW);
    }
    async closeManualHold(session) {
        // A session must never close a different session's valve.
        if (this.openValvePairId && this.openValvePairId !== `hold:${session.sessionId}`)
            return;
        const { column, pin } = this.valveService.calculateColumnAndPin(session.route.address);
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                this.valveService.operateValve(session.route.relayAddress, column, pin, 'CLOSE');
                return;
            }
            catch (error) {
                lastError = error;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        // Same fallback as automatic pulses. If it also fails the hold keeps the output, so
        // nothing else can open while the manager keeps retrying the close.
        try {
            this.valveService.closeAllValves();
            return;
        }
        catch (error) {
            lastError = error;
        }
        throw lastError instanceof Error ? lastError : new Error('manual hold close failed');
    }
    releaseManualHold(session, reason) {
        if (this.openValvePairId === `hold:${session.sessionId}`) {
            this.openValvePairId = null;
            this.lastValveClosedAt = Date.now();
        }
        this.arbiter.endManualControl(session.sessionId);
        void this.wakeNextValveWaiter();
        if (reason !== 'released' && reason !== 'stopped_before_start') {
            console.warn(`Manual hold ${session.sessionId} ended: ${reason}`);
        }
    }
    /** Recorded outcome of one timed pulse, for the executor's truthful completion report. */
    manualPulseStatus(pulseId) {
        return this.manualPulseManager.priorResult(pulseId);
    }
    async holdManualValve(action, body) {
        const enabled = process.env.EXACTH2O_MANUAL_HOLD_ENABLED === '1';
        if (!enabled && action !== 'stop' && action !== 'status') {
            throw new ManualHoldManager_1.HoldError('Hold-to-water is not commissioned on this controller', 'unavailable');
        }
        const signal = {
            sessionId: String((body === null || body === void 0 ? void 0 : body.sessionId) || ''),
            ownerId: String((body === null || body === void 0 ? void 0 : body.ownerId) || ''),
            sequence: Number(body === null || body === void 0 ? void 0 : body.sequence),
            expiresAt: Number(body === null || body === void 0 ? void 0 : body.expiresAt),
            route: {
                relayAddress: Number(body === null || body === void 0 ? void 0 : body.relayAddress),
                address: Number(body === null || body === void 0 ? void 0 : body.address),
                kind: (body === null || body === void 0 ? void 0 : body.destinationKind) === 'solenoid' ? 'solenoid' : 'pot',
                label: typeof (body === null || body === void 0 ? void 0 : body.label) === 'string' ? body.label.slice(0, 80) : undefined,
            },
            takeover: (body === null || body === void 0 ? void 0 : body.takeover) === true,
        };
        const result = await this.manualHoldManager.request(action, signal);
        const arbiter = this.arbiter.snapshot();
        return {
            ...result,
            ready: result.ready && !this.arbiter.fault,
            available: enabled,
            fault: this.arbiter.fault ? this.arbiter.fault.reason : undefined,
            configRewrite: Boolean(arbiter.configRewrite),
            automaticSuspended: Boolean(arbiter.manualControl) || arbiter.manualSettlingForMs > 0,
        };
    }
    /** Read-only snapshot for the independent valve watchdog and diagnostics. */
    getArbiterStatus() {
        var _a, _b;
        const now = Date.now();
        const owner = this.openValvePairId;
        let kind = null;
        let deadlineInMs = null;
        if (owner === null || owner === void 0 ? void 0 : owner.startsWith('hold:')) {
            kind = 'hold';
            deadlineInMs = (_b = (_a = this.manualHoldManager.snapshot().active) === null || _a === void 0 ? void 0 : _a.remainingMs) !== null && _b !== void 0 ? _b : 0;
        }
        else if (owner === null || owner === void 0 ? void 0 : owner.startsWith('manual:')) {
            kind = 'pulse';
            deadlineInMs = this.manualPulseManager.remainingMilliseconds();
        }
        else if (owner) {
            kind = 'automatic';
            const [sensorId, valveId] = owner.split('-');
            const pairing = this.pairingService.getPairing(sensorId, valveId);
            deadlineInMs = (pairing === null || pairing === void 0 ? void 0 : pairing.nextTransitionTime) != null ? Math.max(0, pairing.nextTransitionTime - now) : null;
        }
        return {
            ok: true,
            state: types_1.MachineState[this.state],
            monotonicMs: (0, ValveArbiter_1.monotonicMs)(),
            owner: owner ? { key: owner, kind, deadlineInMs } : null,
            holds: this.manualHoldManager.snapshot(),
            arbiter: this.arbiter.snapshot(),
            watchdogReconciled: this.watchdogReconciled,
        };
    }
    beginConfigRewrite(id, ttlMs) {
        const decision = this.arbiter.beginConfigRewrite(id, ttlMs);
        if (decision.allowed && this.manualHoldManager.snapshot().active) {
            // A hold that has not reached manual control yet still owns the session slot.
            this.arbiter.endConfigRewrite(id);
            return { allowed: false, reason: 'manual watering is in progress; release it before changing the topology', retryInMs: 2000 };
        }
        return decision;
    }
    endConfigRewrite(id) {
        this.arbiter.endConfigRewrite(id);
        void this.wakeNextValveWaiter();
    }
    /** The independent watchdog forced every output off. Nothing opens until reconciled. */
    recordWatchdogTrip(reason) {
        this.watchdogReconciled = false;
        this.arbiter.recordFault(`valve watchdog: ${reason}`, 'watchdog');
    }
    /** After an operator confirms every outlet is closed: close all again, then clear faults. */
    async reconcileValveFault(note) {
        if (this.manualHoldManager.snapshot().active)
            throw new Error('A manual hold is still active');
        if (this.manualPulseManager.hasActivePulse())
            throw new Error('A timed pulse is still active');
        this.valveService.closeAllValves();
        const automatic = this.wateringPulseLedger.activePulse();
        if (automatic)
            await this.wateringPulseLedger.completeActive(automatic.pairId);
        this.openValvePairId = null;
        this.lastValveClosedAt = Date.now();
        this.arbiter.clearFault();
        this.manualHoldManager.reconcileFault();
        this.watchdogReconciled = true;
        void this.wakeNextValveWaiter();
        try {
            await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, { level: 'warn', message: `Valve fault reconciled: ${note.slice(0, 300)}`, source: 'StateMachine' });
        }
        catch (error) {
            console.error('Reconciliation log write failed', error);
        }
        return this.getArbiterStatus();
    }
    async pulseManualValve(request) {
        const manualKey = `manual:${request.pulseId}`;
        // A replay of a pulse that already ran is answered from its record, whatever else is happening.
        const prior = this.manualPulseManager.priorResult(request.pulseId);
        if (prior)
            return prior;
        const decision = this.arbiter.timedPulse();
        if (!decision.allowed)
            throw new Error(`timed pulse refused: ${decision.reason}`);
        if (this.openValvePairId && this.openValvePairId !== manualKey) {
            throw new Error(`another valve is already open: ${this.openValvePairId}`);
        }
        this.openValvePairId = manualKey;
        try {
            const result = await this.manualPulseManager.pulse(request);
            if (!this.manualPulseManager.hasActivePulse() && this.openValvePairId === manualKey) {
                this.openValvePairId = null;
            }
            return result;
        }
        catch (error) {
            if (!this.manualPulseManager.hasActivePulse() && this.openValvePairId === manualKey) {
                this.openValvePairId = null;
            }
            throw error;
        }
    }
    operateManualPulseValve(request, state) {
        const boardAddress = Number(request.relayAddress);
        const { column, pin } = this.valveService.calculateColumnAndPin(Number(request.address));
        this.valveService.operateValve(boardAddress, column, pin, state);
        if (state === 'CLOSE' && this.openValvePairId === `manual:${request.pulseId}`) {
            this.openValvePairId = null;
            this.lastValveClosedAt = Date.now();
            void this.wakeNextValveWaiter();
        }
    }
    operateAutomaticPulseValve(request, state) {
        const { column, pin } = this.valveService.calculateColumnAndPin(request.address);
        this.valveService.operateValve(request.relayAddress, column, pin, state);
    }
    async closeAutomaticPulseWithFallback(request) {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                this.operateAutomaticPulseValve(request, 'CLOSE');
                return;
            }
            catch (error) {
                lastError = error;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        try {
            this.valveService.closeAllValves();
            return;
        }
        catch (error) {
            lastError = error;
        }
        throw lastError instanceof Error ? lastError : new Error('automatic pulse close failed');
    }
    async setState(state) {
        console.log(`StateMachine state transition requested: ${types_1.MachineState[state]}`);
        switch (state) {
            case types_1.MachineState.STARTUP:
            case types_1.MachineState.UPDATE:
                await this.stopEventLoop();
                await this.init(false);
                await this.start();
                break;
            case types_1.MachineState.RUNNING:
                await this.start();
                break;
            case types_1.MachineState.STOPPED:
                await this.stopEventLoop();
                break;
            case types_1.MachineState.RESET:
                await this.stopEventLoop();
                await this.init();
                break;
            default:
                console.error(`Unknown state: ${state}`);
                break;
        }
    }
    getState() {
        return this.state;
    }
    pairingsLoaded() {
        return this.pairingService.isPairingsFetched();
    }
    async operateSensor(boardSerialId, sensorAddress, measurements = 1) {
        return await this.sensorService.operateSensor(boardSerialId, sensorAddress, measurements);
    }
    calculateColumnAndPin(address) {
        return this.valveService.calculateColumnAndPin(address);
    }
    operateValve(boardAddress, column, pin, state) {
        return this.valveService.operateValve(boardAddress, column, pin, state);
    }
    async getQueueStats() {
        return await this.eventQueueService.getQueueStats();
    }
    async clearStuckJobs() {
        console.log('Clearing stuck jobs from StateMachine...');
        await this.eventQueueService.clearStuckJobs();
    }
    async logQueueSummary() {
        await this.eventQueueService.logQueueSummary();
    }
}
exports.default = StateMachine;

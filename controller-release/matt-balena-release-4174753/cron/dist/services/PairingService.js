"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PairingService = void 0;
const constants_1 = require("../config/constants");
/**
 * Service responsible for managing pairing data and state
 */
class PairingService {
    constructor(apiService, standardDelayTime) {
        this.apiService = apiService;
        this.standardDelayTime = standardDelayTime;
        this.pairings = new Map();
        this.pairingsFetched = false;
    }
    async fetchPairings() {
        this.pairingsFetched = false;
        const pairings = await this.apiService.fetchData(constants_1.API_ENDPOINTS.PAIRINGS);
        console.log('Pairings fetched:', Array.isArray(pairings) ? pairings.length : pairings);
        if (!Array.isArray(pairings)) {
            throw new Error('Pairings API returned a non-array response; refusing to start scheduler');
        }
        if (pairings.length === 0) {
            throw new Error('Pairings API returned zero pairings; refusing to start empty scheduler');
        }
        pairings.forEach((pairing) => {
            this.addPairing(pairing, {
                measurementTime: constants_1.DEFAULT_TIMING.SENSOR_READING_TIME,
                startDelayTime: this.standardDelayTime,
                delayTime: constants_1.DEFAULT_TIMING.PROCESSING_DELAY,
                valveOpenTime: pairing.ValveOpenTime,
                intervalTime: pairing.MeasurementInterval,
            }, pairing.WTCPercentLimit);
        });
        this.pairingsFetched = true;
    }
    /**
     * Clear all in-memory pairings and reset fetched flag.
     * Use when performing a full reload (e.g., on StateMachine restart)
     * to avoid retaining stale pairings that no longer exist in the API.
     */
    clearPairings() {
        if (this.pairings.size > 0) {
            console.log(`Clearing ${this.pairings.size} existing pairings before reload`);
        }
        else {
            console.log('No existing pairings to clear');
        }
        this.pairings.clear();
        this.pairingsFetched = false;
    }
    addPairing(pairing, timingRules, WTCPercentLimit = 0) {
        const pairingId = `${pairing.sensorId}-${pairing.valveId}`;
        const state = {
            ...pairing,
            WTCPercentLimit: WTCPercentLimit,
            timingRules,
            state: 'STARTUP',
            WTCPercentMeasured: null,
            lastMeasurementAt: null,
            previousWTCPercentMeasured: null,
            previousMeasurementAt: null,
            measurementValid: false,
            wateringMeasurementValid: false,
            valveOpened: false,
            lastValveOpenedAt: null,
            wateringWindowStartedAt: null,
            wateringWindowPulseCount: 0,
            nextTransitionTime: null,
        };
        this.pairings.set(pairingId, state);
    }
    getPairing(sensorId, valveId) {
        const pairingId = `${sensorId}-${valveId}`;
        return this.pairings.get(pairingId);
    }
    getAllPairings() {
        return Array.from(this.pairings.values());
    }
    getPairingById(pairingId) {
        return this.pairings.get(pairingId);
    }
    setPairingState(sensorId, valveId, newState) {
        const pairing = this.getPairing(sensorId, valveId);
        if (pairing) {
            pairing.state = newState;
        }
    }
    isPairingsFetched() {
        return this.pairingsFetched;
    }
    getMap() {
        return this.pairings;
    }
}
exports.PairingService = PairingService;

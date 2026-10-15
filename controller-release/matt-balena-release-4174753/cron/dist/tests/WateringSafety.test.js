"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("../config/constants");
const WateringSafety_1 = require("../services/WateringSafety");
const now = Date.now();
function pairing(overrides = {}) {
    const base = {
        sensorId: 711,
        valveId: 1584,
        groupId: 2,
        name: 'Zone4-Pot95',
        WTCPercentLimit: 20,
        ValveOpenTime: 3000,
        MeasurementInterval: 600000,
        createdAt: '2026-06-24T00:00:00.000Z',
        updatedAt: '2026-06-24T00:00:00.000Z',
        state: 'DELAY',
        nextTransitionTime: now,
        timingRules: {
            measurementTime: constants_1.DEFAULT_TIMING.SENSOR_READING_TIME,
            startDelayTime: constants_1.DEFAULT_TIMING.STANDARD_DELAY,
            delayTime: constants_1.DEFAULT_TIMING.PROCESSING_DELAY,
            valveOpenTime: 3000,
            intervalTime: 600000,
        },
        WTCPercentMeasured: 12.5,
        lastMeasurementAt: now,
        previousWTCPercentMeasured: 13,
        previousMeasurementAt: null,
        measurementValid: true,
        wateringMeasurementValid: true,
        valveOpened: false,
        lastValveOpenedAt: null,
        wateringWindowStartedAt: null,
        wateringWindowPulseCount: 0,
        Sensor: {
            id: 711,
            address: 'o',
            type: 'SDI12',
            description: 'Pot95',
            name: 'sensor-711',
            boardSerialId: 'D30GQN2D',
            createdAt: '2026-06-24T00:00:00.000Z',
            updatedAt: '2026-06-24T00:00:00.000Z',
        },
        Valve: {
            id: 1584,
            address: '48',
            relayAddress: '0x20',
            description: 'Pot95 valve',
            name: 'valve-1584',
            createdAt: '2026-06-24T00:00:00.000Z',
            updatedAt: '2026-06-24T00:00:00.000Z',
        },
        Calibration: {
            id: 1,
            name: 'matts greenhouse pots',
            polynomialCoefficientsCommaDelimited: '100.68,-0.1289,0.00004,0,0,0',
            readingsJSONString: '{}',
        },
    };
    return { ...base, ...overrides };
}
describe('WateringSafety', () => {
    it('allows a fresh calibrated reading below threshold', () => {
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(pairing(), now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE);
        expect(decision.allowed).toBe(true);
    });
    it('allows watering without trend history when the fresh reading is below threshold', () => {
        const noTrend = pairing({ previousWTCPercentMeasured: null });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(noTrend, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY);
        expect(decision.allowed).toBe(true);
    });
    it('allows a second pulse inside the settling window when the fresh reading is still below threshold', () => {
        const stabilizing = pairing({
            lastValveOpenedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY - 1000,
            wateringWindowStartedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY - 1000,
            wateringWindowPulseCount: 1,
        });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(stabilizing, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY);
        expect(decision.allowed).toBe(true);
    });
    it('blocks immediate repeated watering before the minimum retry interval expires', () => {
        const tooSoon = pairing({
            lastValveOpenedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY + 1000,
            wateringWindowStartedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY + 1000,
            wateringWindowPulseCount: 1,
        });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(tooSoon, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY);
        expect(decision.allowed).toBe(false);
        expect(decision.normalHold).toBe(true);
        expect(decision.reason).toContain('minimum');
    });
    it('blocks a third pulse inside the settling window', () => {
        const maxed = pairing({
            lastValveOpenedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY - 1000,
            wateringWindowStartedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY - 1000,
            wateringWindowPulseCount: constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW,
        });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(maxed, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY);
        expect(decision.allowed).toBe(false);
        expect(decision.normalHold).toBe(true);
        expect(decision.reason).toContain('pulse limit');
    });
    it('allows watering when the reading is still below threshold and not rising', () => {
        const settled = pairing({
            lastValveOpenedAt: now - 1000,
            previousWTCPercentMeasured: 13,
            WTCPercentMeasured: 12.5,
        });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(settled, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, 0);
        expect(decision.allowed).toBe(true);
    });
    it('allows watering while the moisture reading is rising but still below threshold', () => {
        const rising = pairing({
            previousWTCPercentMeasured: 11.9,
            WTCPercentMeasured: 12.5,
        });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(rising, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY);
        expect(decision.allowed).toBe(true);
    });
    it('resets the pulse budget when the settling window expires', () => {
        const expired = pairing({
            lastValveOpenedAt: now - constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW - 1000,
            wateringWindowStartedAt: now - constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW - 1000,
            wateringWindowPulseCount: constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW,
        });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(expired, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY);
        expect(decision.allowed).toBe(true);
    });
    it('records valve opens into a bounded settling window', () => {
        const state = pairing();
        (0, WateringSafety_1.recordValveOpen)(state, now, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW);
        expect(state.lastValveOpenedAt).toBe(now);
        expect(state.wateringWindowStartedAt).toBe(now);
        expect(state.wateringWindowPulseCount).toBe(1);
        (0, WateringSafety_1.recordValveOpen)(state, now + constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY + 1000, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW);
        expect(state.wateringWindowStartedAt).toBe(now);
        expect(state.wateringWindowPulseCount).toBe(2);
        (0, WateringSafety_1.resetWateringWindow)(state);
        expect(state.wateringWindowStartedAt).toBeNull();
        expect(state.wateringWindowPulseCount).toBe(0);
    });
    it('blocks disabled watering config', () => {
        const disabled = pairing({ WTCPercentLimit: -999999, ValveOpenTime: 0 });
        expect((0, WateringSafety_1.isWateringConfigEnabled)(disabled)).toBe(false);
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(disabled, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('watering config');
    });
    it('blocks missing sensor readings', () => {
        const missing = pairing({
            WTCPercentMeasured: null,
            lastMeasurementAt: null,
            measurementValid: false,
            wateringMeasurementValid: false,
        });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(missing, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE);
        expect(decision.allowed).toBe(false);
        expect(decision.fault).toBe(true);
    });
    it('blocks stale readings', () => {
        const stale = pairing({ lastMeasurementAt: now - constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE - 1 });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(stale, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('stale');
    });
    it('blocks readings above recovery without faulting the sensor', () => {
        const wet = pairing({ WTCPercentMeasured: 35 });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(wet, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE);
        expect(decision.allowed).toBe(false);
        expect(decision.fault).toBeUndefined();
        expect(decision.reason).toContain('recovery target');
    });
    it('derives the watering band from the pairing target with no offset', () => {
        expect((0, WateringSafety_1.getWateringBand)(pairing({ WTCPercentLimit: 15 }), 0, 0)).toEqual({
            floor: 15,
            trigger: 15,
            recoveryMax: 15,
        });
    });
    it('starts watering only when the reading is below the floor', () => {
        const belowFloor = pairing({ WTCPercentLimit: 15, WTCPercentMeasured: 14.9 });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(belowFloor, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY, 0, 0);
        expect(decision.allowed).toBe(true);
    });
    it('does not start a new correction episode at the floor', () => {
        const atFloor = pairing({ WTCPercentLimit: 15, WTCPercentMeasured: 15 });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(atFloor, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY, 0, 0);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('recovery target');
    });
    it('continues an active correction episode while still below the floor', () => {
        const active = pairing({
            WTCPercentLimit: 15,
            WTCPercentMeasured: 14.9,
            lastValveOpenedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY - 1000,
            wateringWindowStartedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY - 1000,
            wateringWindowPulseCount: 1,
        });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(active, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY, 0, 0);
        expect(decision.allowed).toBe(true);
        expect((0, WateringSafety_1.shouldAttemptWatering)(active, now, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, 0, 0)).toBe(true);
    });
    it('stops an active correction episode at the floor', () => {
        const recovered = pairing({
            WTCPercentLimit: 15,
            WTCPercentMeasured: 15,
            lastValveOpenedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY - 1000,
            wateringWindowStartedAt: now - constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY - 1000,
            wateringWindowPulseCount: 1,
        });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(recovered, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE, constants_1.DEFAULT_TIMING.WATERING_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MAX_WATERING_PULSES_PER_SETTLE_WINDOW, constants_1.DEFAULT_TIMING.MIN_WATERING_RETRY, 0, 0);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('recovery target');
    });
    it('blocks uncalibrated pairings even if the number is below threshold', () => {
        const uncalibrated = pairing({ Calibration: undefined });
        const decision = (0, WateringSafety_1.getValveOpenSafetyDecision)(uncalibrated, now, constants_1.DEFAULT_TIMING.MAX_WATERING_READING_AGE);
        expect(decision.allowed).toBe(false);
        expect(decision.fault).toBe(true);
        expect(decision.reason).toContain('calibration');
    });
});

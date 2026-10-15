"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SDI12_ADDRESS_POOL = exports.DEFAULT_REDIS_CONFIG = exports.DEFAULT_TIMING = exports.VALVE_CONFIGURATION = exports.API_ENDPOINTS = exports.DEFAULT_BOARD_CONFIGS = void 0;
exports.DEFAULT_BOARD_CONFIGS = [
    { address: 0x20, resetPin: 17 },
    { address: 0x21, resetPin: 23 },
];
exports.API_ENDPOINTS = {
    PAIRINGS: '/v1/pairings',
    READINGS: '/v1/readings',
    VALVES: '/v1/valves',
    SENSORS: '/v1/sensors',
    LOGS: '/v1/logs',
    BOARD_CONFIGS: '/v1/system/board-configs'
};
exports.VALVE_CONFIGURATION = {
    COLS: 6,
    ROWS: 8
};
const SENSOR_READING_TIME_MS = 210000;
const PROCESSING_DELAY_MS = 30000;
function positiveNumberEnv(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function nonNegativeNumberEnv(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
const WATERING_SETTLE_WINDOW_MS = positiveNumberEnv('WATERING_SETTLE_WINDOW_MS', 60 * 60 * 1000);
const MIN_WATERING_RETRY_MS = positiveNumberEnv('MIN_WATERING_RETRY_MS', 30 * 60 * 1000);
const MAX_WATERING_PULSES_PER_SETTLE_WINDOW = positiveNumberEnv('MAX_WATERING_PULSES_PER_SETTLE_WINDOW', 2);
const WATERING_TRIGGER_OFFSET_PERCENT = nonNegativeNumberEnv('WATERING_TRIGGER_OFFSET_PERCENT', 0);
const WATERING_RECOVERY_OFFSET_PERCENT = nonNegativeNumberEnv('WATERING_RECOVERY_OFFSET_PERCENT', 0);
const VALVE_CONFLICT_RETRY_DELAY_MS = positiveNumberEnv('VALVE_CONFLICT_RETRY_DELAY_MS', 30 * 1000);
const VALVE_RECOVERY_DELAY_MS = nonNegativeNumberEnv('VALVE_RECOVERY_DELAY_MS', 30 * 1000);
exports.DEFAULT_TIMING = {
    STANDARD_DELAY: 1000,
    STANDARD_VALVE_CLOSE: 1000,
    PROCESSING_DELAY: PROCESSING_DELAY_MS,
    SENSOR_READING_TIME: SENSOR_READING_TIME_MS,
    MAX_WATERING_READING_AGE: SENSOR_READING_TIME_MS + PROCESSING_DELAY_MS + 60000,
    WATERING_SETTLE_WINDOW: WATERING_SETTLE_WINDOW_MS,
    MIN_WATERING_RETRY: MIN_WATERING_RETRY_MS,
    MAX_WATERING_PULSES_PER_SETTLE_WINDOW,
    WATERING_TRIGGER_OFFSET_PERCENT,
    WATERING_RECOVERY_OFFSET_PERCENT,
    VALVE_CONFLICT_RETRY_DELAY: VALVE_CONFLICT_RETRY_DELAY_MS,
    VALVE_RECOVERY_DELAY: VALVE_RECOVERY_DELAY_MS
};
exports.DEFAULT_REDIS_CONFIG = {
    HOST: process.env.REDIS_HOST || 'localhost',
    PORT: parseInt(process.env.REDIS_PORT || '6379'),
    PASSWORD: process.env.REDIS_PASSWORD || undefined,
    DB: parseInt(process.env.REDIS_DB || '0')
};
// Full valid SDI-12 address pool (62 addresses): 0-9, A-Z, a-z
// Exported as an immutable array for reuse across controllers/services.
exports.SDI12_ADDRESS_POOL = ('0123456789' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
    'abcdefghijklmnopqrstuvwxyz').split('');

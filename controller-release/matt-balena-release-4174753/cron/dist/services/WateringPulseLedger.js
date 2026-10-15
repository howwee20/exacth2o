"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WateringPulseLedger = void 0;
const promises_1 = require("fs/promises");
const path_1 = __importDefault(require("path"));
/**
 * Durable, fail-closed accounting for automatic irrigation pulses.
 *
 * The Bull queue serializes state transitions, but its job payload is not a
 * reliable safety ledger and is cleared when the controller is stopped or
 * restarted. This service persists the timestamps that enforce the per-pot
 * rolling limit and minimum retry interval to the cron_config volume.
 */
class WateringPulseLedger {
    constructor(filePath, retentionMs = 24 * 60 * 60 * 1000) {
        this.filePath = filePath;
        this.retentionMs = retentionMs;
        this.pulses = new Map();
        this.active = null;
        this.initialized = false;
    }
    async init(now = Date.now()) {
        try {
            const parsed = JSON.parse(await (0, promises_1.readFile)(this.filePath, 'utf8'));
            if (![1, 2].includes(parsed === null || parsed === void 0 ? void 0 : parsed.version) || !parsed.pulses || typeof parsed.pulses !== 'object') {
                throw new Error('automatic pulse ledger has an unsupported format');
            }
            for (const [pairId, timestamps] of Object.entries(parsed.pulses)) {
                if (!Array.isArray(timestamps)) {
                    throw new Error(`automatic pulse ledger entry is invalid: ${pairId}`);
                }
                const valid = timestamps
                    .map(Number)
                    .filter((value) => Number.isFinite(value) && value <= now + 1000 && now - value <= this.retentionMs)
                    .sort((left, right) => left - right);
                if (valid.length > 0)
                    this.pulses.set(pairId, valid);
            }
            if (parsed.version === 2 && parsed.active != null) {
                const active = parsed.active;
                if (typeof active.pairId !== 'string' ||
                    !active.pairId ||
                    !Number.isInteger(active.relayAddress) ||
                    active.relayAddress < 0 ||
                    active.relayAddress > 0x7f ||
                    !Number.isInteger(active.address) ||
                    active.address < 1 ||
                    !Number.isFinite(active.startedAt) ||
                    active.startedAt > now + 1000) {
                    throw new Error('automatic pulse ledger active valve is invalid');
                }
                this.active = { ...active };
            }
        }
        catch (error) {
            if ((error === null || error === void 0 ? void 0 : error.code) !== 'ENOENT')
                throw error;
        }
        this.initialized = true;
        await this.persist(now);
    }
    decision(pairId, now, windowMs, maxPulses, minRetryMs) {
        this.requireInitialized();
        const recent = this.recent(pairId, now, windowMs);
        const lastPulseAt = recent.length > 0 ? recent[recent.length - 1] : null;
        if (lastPulseAt !== null && minRetryMs > 0 && now - lastPulseAt < minRetryMs) {
            return {
                allowed: false,
                pulseCount: recent.length,
                lastPulseAt,
                retryAt: lastPulseAt + minRetryMs,
                reason: 'minimum_retry',
            };
        }
        if (Number.isFinite(maxPulses) && maxPulses >= 0 && recent.length >= maxPulses) {
            return {
                allowed: false,
                pulseCount: recent.length,
                lastPulseAt,
                retryAt: recent[recent.length - maxPulses] + windowMs,
                reason: 'rolling_limit',
            };
        }
        return {
            allowed: true,
            pulseCount: recent.length,
            lastPulseAt,
            retryAt: null,
        };
    }
    async reserve(pairId, now, windowMs, maxPulses, minRetryMs) {
        if (this.active) {
            throw new Error(`automatic valve closure is still pending: ${this.active.pairId}`);
        }
        const decision = this.decision(pairId, now, windowMs, maxPulses, minRetryMs);
        if (!decision.allowed)
            return decision;
        const retained = this.timestamps(pairId).filter((value) => now - value <= this.retentionMs);
        retained.push(now);
        this.pulses.set(pairId, retained);
        await this.persist(now);
        return { ...decision, pulseCount: decision.pulseCount + 1, lastPulseAt: now };
    }
    activePulse() {
        this.requireInitialized();
        return this.active ? { ...this.active } : null;
    }
    async beginActive(pairId, relayAddress, address, startedAt = Date.now()) {
        this.requireInitialized();
        if (this.active) {
            throw new Error(`automatic valve closure is still pending: ${this.active.pairId}`);
        }
        if (!pairId ||
            !Number.isInteger(relayAddress) ||
            relayAddress < 0 ||
            relayAddress > 0x7f ||
            !Number.isInteger(address) ||
            address < 1 ||
            !Number.isFinite(startedAt)) {
            throw new Error('automatic active valve record is invalid');
        }
        this.active = { pairId, relayAddress, address, startedAt };
        await this.persist(startedAt);
        return { ...this.active };
    }
    async completeActive(pairId, now = Date.now()) {
        this.requireInitialized();
        if (!this.active)
            return;
        if (this.active.pairId !== pairId) {
            throw new Error(`automatic active valve mismatch: ${this.active.pairId}`);
        }
        this.active = null;
        await this.persist(now);
    }
    recent(pairId, now, windowMs) {
        return this.timestamps(pairId).filter((value) => value >= now - windowMs && value <= now + 1000);
    }
    timestamps(pairId) {
        return [...(this.pulses.get(pairId) || [])].sort((left, right) => left - right);
    }
    requireInitialized() {
        if (!this.initialized)
            throw new Error('automatic pulse ledger is not initialized');
    }
    async persist(now) {
        this.requireInitialized();
        const pulses = {};
        for (const [pairId, timestamps] of this.pulses.entries()) {
            const retained = timestamps.filter((value) => now - value <= this.retentionMs);
            if (retained.length > 0)
                pulses[pairId] = retained;
        }
        await (0, promises_1.mkdir)(path_1.default.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.tmp`;
        await (0, promises_1.writeFile)(temporaryPath, JSON.stringify({ version: 2, pulses, active: this.active }, null, 2), 'utf8');
        await (0, promises_1.rename)(temporaryPath, this.filePath);
    }
}
exports.WateringPulseLedger = WateringPulseLedger;

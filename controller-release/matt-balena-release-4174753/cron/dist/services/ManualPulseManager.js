"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManualPulseManager = void 0;
const promises_1 = require("fs/promises");
const emptyState = () => ({ active: null, records: [] });
class ManualPulseManager {
    constructor(stateFile, openValve, closeValve, emergencyCloseAll, maxDurationMilliseconds = 60000, maxCommandValveMilliseconds = 120000) {
        this.stateFile = stateFile;
        this.openValve = openValve;
        this.closeValve = closeValve;
        this.emergencyCloseAll = emergencyCloseAll;
        this.maxDurationMilliseconds = maxDurationMilliseconds;
        this.maxCommandValveMilliseconds = maxCommandValveMilliseconds;
        this.state = emptyState();
        this.timer = null;
        this.loaded = false;
    }
    hasActivePulse() {
        return this.state.active !== null;
    }
    result(record, duplicate) {
        return {
            pulseId: record.pulseId,
            commandId: record.commandId,
            status: record.status,
            duplicate,
            startedAt: record.startedAt,
            closedAt: record.closedAt,
        };
    }
    async load() {
        var _a;
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const parsed = JSON.parse(await (0, promises_1.readFile)(this.stateFile, 'utf8'));
            this.state = {
                active: (_a = parsed === null || parsed === void 0 ? void 0 : parsed.active) !== null && _a !== void 0 ? _a : null,
                records: Array.isArray(parsed === null || parsed === void 0 ? void 0 : parsed.records) ? parsed.records.slice(-200) : [],
            };
        }
        catch (error) {
            if ((error === null || error === void 0 ? void 0 : error.code) !== 'ENOENT')
                throw error;
            this.state = emptyState();
        }
    }
    async persist() {
        const tempFile = `${this.stateFile}.tmp`;
        await (0, promises_1.writeFile)(tempFile, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        await (0, promises_1.rename)(tempFile, this.stateFile);
    }
    async recover() {
        await this.load();
        if (!this.state.active)
            return;
        const active = this.state.active;
        try {
            await this.closeWithFallback(active);
            active.status = 'recovered_closed';
        }
        catch (error) {
            active.status = 'failed';
            active.error = `restart recovery close failed: ${(error === null || error === void 0 ? void 0 : error.message) || error}`;
            throw error;
        }
        finally {
            active.closedAt = new Date().toISOString();
            this.state.records.push(active);
            this.state.records = this.state.records.slice(-200);
            this.state.active = null;
            await this.persist();
        }
    }
    async pulse(request) {
        var _a, _b, _c;
        await this.load();
        const duration = Number(request.durationMilliseconds);
        if (!request.pulseId || !request.commandId)
            throw new Error('pulseId and commandId are required');
        if (!Number.isInteger(duration) || duration < 1 || duration > this.maxDurationMilliseconds) {
            throw new Error(`durationMilliseconds must be between 1 and ${this.maxDurationMilliseconds}`);
        }
        const prior = this.state.records.find((record) => record.pulseId === request.pulseId);
        if (prior)
            return this.result(prior, true);
        if (((_a = this.state.active) === null || _a === void 0 ? void 0 : _a.pulseId) === request.pulseId)
            return this.result(this.state.active, true);
        if (this.state.active)
            throw new Error(`manual pulse already active: ${this.state.active.pulseId}`);
        const commandTotal = this.state.records
            .filter((record) => record.commandId === request.commandId)
            .reduce((sum, record) => sum + Number(record.durationMilliseconds || 0), 0);
        if (commandTotal + duration > this.maxCommandValveMilliseconds) {
            throw new Error(`manual pulse command exceeds ${this.maxCommandValveMilliseconds} aggregate valve-milliseconds`);
        }
        const active = {
            ...request,
            durationMilliseconds: duration,
            status: 'opening',
            startedAt: new Date().toISOString(),
        };
        this.state.active = active;
        await this.persist();
        try {
            await this.openValve(active);
            active.status = 'open';
            await this.persist();
            this.timer = setTimeout(() => {
                void this.closeActive().catch((error) => {
                    console.error('Manual pulse close failed after fallback', error);
                });
            }, duration);
            (_c = (_b = this.timer).unref) === null || _c === void 0 ? void 0 : _c.call(_b);
            return this.result(active, false);
        }
        catch (error) {
            active.status = 'failed';
            active.error = (error === null || error === void 0 ? void 0 : error.message) || String(error);
            active.closedAt = new Date().toISOString();
            this.state.records.push(active);
            this.state.active = null;
            await this.persist();
            throw error;
        }
    }
    async closeActive() {
        await this.load();
        if (!this.state.active)
            return null;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        const active = this.state.active;
        try {
            await this.closeWithFallback(active);
            active.status = 'closed';
        }
        catch (error) {
            active.status = 'failed';
            active.error = (error === null || error === void 0 ? void 0 : error.message) || String(error);
            throw error;
        }
        finally {
            active.closedAt = new Date().toISOString();
            this.state.records.push(active);
            this.state.records = this.state.records.slice(-200);
            this.state.active = null;
            await this.persist();
        }
        return this.result(active, false);
    }
    async closeWithFallback(request) {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await this.closeValve(request);
                return;
            }
            catch (error) {
                lastError = error;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        try {
            await this.emergencyCloseAll();
            return;
        }
        catch (error) {
            lastError = error;
        }
        throw lastError instanceof Error ? lastError : new Error('manual pulse close failed');
    }
}
exports.ManualPulseManager = ManualPulseManager;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManualHoldManager = void 0;
const promises_1 = require("fs/promises");
class ManualHoldManager {
    constructor(file, open, close, leaseMs = 2500, maxMs = 15000) {
        this.file = file;
        this.open = open;
        this.close = close;
        this.leaseMs = leaseMs;
        this.maxMs = maxMs;
        this.state = { active: null, records: [] };
        this.queue = Promise.resolve();
        this.timer = null;
        this.ready = false;
    }
    serial(fn) {
        const next = this.queue.then(fn);
        this.queue = next.catch(() => { });
        return next;
    }
    async save() {
        await (0, promises_1.writeFile)(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
        await (0, promises_1.rename)(this.file + '.tmp', this.file);
    }
    async recover() {
        return this.serial(async () => {
            try {
                this.state = JSON.parse(await (0, promises_1.readFile)(this.file, 'utf8'));
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
            }
            if (this.state.active)
                await this.finish();
            this.ready = true;
        });
    }
    arm() {
        var _a, _b;
        if (this.timer)
            clearTimeout(this.timer);
        if (!this.state.active)
            return;
        this.timer = setTimeout(() => { void this.serial(() => this.finish()).catch(() => { }); }, Math.max(0, this.state.active.deadline - Date.now()));
        (_b = (_a = this.timer).unref) === null || _b === void 0 ? void 0 : _b.call(_a);
    }
    async finish() {
        const r = this.state.active;
        if (!r)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        try {
            await this.close(r);
        }
        catch (e) {
            r.status = 'fault';
            this.ready = false;
            await this.save();
            throw e;
        }
        r.status = 'closed';
        this.state.active = null;
        this.state.records.push(r);
        this.state.records = this.state.records.filter(x => Date.now() - x.startedAt < 120000);
        await this.save();
    }
    async stopAll() { return this.serial(() => this.finish()); }
    async request(action, r) {
        return this.serial(async () => {
            var _a, _b;
            if (!this.ready)
                throw new Error('Manual control unavailable: controller recovery required');
            if (!/^[a-zA-Z0-9-]{16,80}$/.test(r.sessionId) || !r.ownerId || !Number.isInteger(r.sequence) || r.sequence < 0)
                throw new Error('Invalid hold identity');
            let active = this.state.active;
            if (active && Date.now() >= active.deadline) {
                await this.finish();
                active = null;
            }
            const prior = this.state.records.find(x => x.sessionId === r.sessionId);
            const existing = (active === null || active === void 0 ? void 0 : active.sessionId) === r.sessionId ? active : prior;
            if (existing && existing.ownerId !== r.ownerId)
                throw new Error('Hold owner mismatch');
            if (action === 'stop') {
                if ((active === null || active === void 0 ? void 0 : active.sessionId) === r.sessionId)
                    await this.finish();
                else if (!prior) {
                    this.state.records.push({ ...r, startedAt: Date.now(), deadline: Date.now(), status: 'closed' });
                    await this.save();
                }
                return { status: 'closed', sessionId: r.sessionId };
            }
            if (action === 'status')
                return { status: (existing === null || existing === void 0 ? void 0 : existing.status) || 'closed', sessionId: r.sessionId };
            if (prior)
                return { status: prior.status, sessionId: r.sessionId };
            if (!Number.isFinite(r.expiresAt) || r.expiresAt <= Date.now() || r.expiresAt > Date.now() + this.leaseMs)
                throw new Error('Hold signal expired');
            if (active && active.sessionId !== r.sessionId)
                throw new Error('Another manual hold is active');
            if (action === 'renew') {
                if (!active)
                    return { status: 'closed', sessionId: r.sessionId };
                if (active.address !== r.address || active.relayAddress !== r.relayAddress)
                    throw new Error('Hold route changed');
                if (r.sequence > active.sequence) {
                    active.sequence = r.sequence;
                    active.deadline = Math.min(r.expiresAt, active.startedAt + this.maxMs);
                    await this.save();
                    this.arm();
                }
            }
            else if (!active) {
                active = { ...r, startedAt: Date.now(), deadline: Math.min(r.expiresAt, Date.now() + this.maxMs), status: 'open' };
                this.state.active = active;
                await this.save();
                try {
                    await this.open(r);
                }
                catch (e) {
                    await this.finish();
                    throw e;
                }
                if (Date.now() >= active.deadline)
                    await this.finish();
                else
                    this.arm();
            }
            return { status: ((_a = this.state.active) === null || _a === void 0 ? void 0 : _a.status) || 'closed', sessionId: r.sessionId, startedAt: active === null || active === void 0 ? void 0 : active.startedAt, deadline: (_b = this.state.active) === null || _b === void 0 ? void 0 : _b.deadline, maxMilliseconds: this.maxMs };
        });
    }
}
exports.ManualHoldManager = ManualHoldManager;

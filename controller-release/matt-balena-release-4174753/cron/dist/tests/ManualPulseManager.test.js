"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("fs/promises");
const os_1 = require("os");
const path_1 = __importDefault(require("path"));
const ManualPulseManager_1 = require("../services/ManualPulseManager");
const request = {
    pulseId: 'command-1:0x20:3',
    commandId: 'command-1',
    relayAddress: 0x20,
    address: 3,
    durationMilliseconds: 20,
};
async function fixture() {
    const directory = await (0, promises_1.mkdtemp)(path_1.default.join((0, os_1.tmpdir)(), 'exacth2o-pulse-'));
    const stateFile = path_1.default.join(directory, 'manual-pulses.json');
    const calls = [];
    const manager = new ManualPulseManager_1.ManualPulseManager(stateFile, () => { calls.push('OPEN'); }, () => { calls.push('CLOSE'); }, () => { calls.push('CLOSE_ALL'); }, 100, 120);
    return { directory, stateFile, calls, manager };
}
describe('ManualPulseManager', () => {
    test('owns the close timer and deduplicates the same pulse id', async () => {
        const { directory, calls, manager } = await fixture();
        try {
            const first = await manager.pulse(request);
            const duplicateWhileOpen = await manager.pulse(request);
            expect(first.duplicate).toBe(false);
            expect(duplicateWhileOpen.duplicate).toBe(true);
            expect(calls).toEqual(['OPEN']);
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(calls).toEqual(['OPEN', 'CLOSE']);
            const duplicateAfterClose = await manager.pulse(request);
            expect(duplicateAfterClose.duplicate).toBe(true);
            expect(calls).toEqual(['OPEN', 'CLOSE']);
        }
        finally {
            await (0, promises_1.rm)(directory, { recursive: true, force: true });
        }
    });
    test('closes a persisted active pulse before accepting work after restart', async () => {
        const { directory, stateFile, calls, manager } = await fixture();
        try {
            await (0, promises_1.writeFile)(stateFile, JSON.stringify({
                active: { ...request, status: 'open', startedAt: new Date().toISOString() },
                records: [],
            }));
            await manager.recover();
            expect(calls).toEqual(['CLOSE']);
            const stored = JSON.parse(await (0, promises_1.readFile)(stateFile, 'utf8'));
            expect(stored.active).toBeNull();
            expect(stored.records[0].status).toBe('recovered_closed');
        }
        finally {
            await (0, promises_1.rm)(directory, { recursive: true, force: true });
        }
    });
    test('rejects conflicts, duration overflow, and aggregate command overflow', async () => {
        const { directory, manager } = await fixture();
        try {
            await expect(manager.pulse({ ...request, durationMilliseconds: 101 })).rejects.toThrow('between 1 and 100');
            await manager.pulse({ ...request, durationMilliseconds: 70 });
            await expect(manager.pulse({
                ...request,
                pulseId: 'command-2:0x20:4',
                commandId: 'command-2',
                address: 4,
            })).rejects.toThrow('already active');
            await manager.closeActive();
            await expect(manager.pulse({
                ...request,
                pulseId: 'command-1:0x20:4',
                address: 4,
                durationMilliseconds: 60,
            })).rejects.toThrow('aggregate');
        }
        finally {
            await (0, promises_1.rm)(directory, { recursive: true, force: true });
        }
    });
    test('uses emergency close-all after repeated close failures', async () => {
        const directory = await (0, promises_1.mkdtemp)(path_1.default.join((0, os_1.tmpdir)(), 'exacth2o-pulse-'));
        const calls = [];
        const manager = new ManualPulseManager_1.ManualPulseManager(path_1.default.join(directory, 'state.json'), () => { calls.push('OPEN'); }, () => { calls.push('CLOSE'); throw new Error('i2c close failed'); }, () => { calls.push('CLOSE_ALL'); }, 100, 120);
        try {
            await manager.pulse(request);
            await manager.closeActive();
            expect(calls).toEqual(['OPEN', 'CLOSE', 'CLOSE', 'CLOSE', 'CLOSE_ALL']);
        }
        finally {
            await (0, promises_1.rm)(directory, { recursive: true, force: true });
        }
    });
});

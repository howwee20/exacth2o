"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.i2cBusMock = void 0;
// filepath: /Users/cwd/Desktop/_code/ursa-science/projects/walkerLabs/wl_master/cron/src/controllers/mocks/i2c-bus.ts
exports.i2cBusMock = {
    openSync: (busNumber) => ({
        scanSync: () => {
            console.log(`Mock scanSync called on bus ${busNumber}`);
            // Simulate finding devices at addresses 0x20 and 0x21
            return [0x20, 0x21];
        },
        i2cWriteSync: (address, length, buffer) => {
            console.log(`Mock i2cWriteSync called with address 0x${address.toString(16)}, length ${length}, buffer [${buffer.toString()}]`);
        },
        i2cReadSync: (address, length, buffer) => {
            console.log(`Mock i2cReadSync called with address 0x${address.toString(16)}, length ${length}`);
            // Simulate reading by filling the buffer with dummy data
            buffer.fill(0xFF, 0, length);
            return length;
        },
        closeSync: () => {
            console.log('Mock closeSync called');
        },
    }),
};
// Export as CommonJS for compatibility with `require`
module.exports = exports.i2cBusMock;

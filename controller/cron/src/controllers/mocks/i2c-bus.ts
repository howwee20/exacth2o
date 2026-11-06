// filepath: /Users/cwd/Desktop/_code/ursa-science/projects/walkerLabs/wl_master/cron/src/controllers/mocks/i2c-bus.ts
export const i2cBusMock = {
  openSync: (busNumber: number) => ({
    scanSync: (): number[] => {
      console.log(`Mock scanSync called on bus ${busNumber}`);
      // Simulate finding devices at addresses 0x20 and 0x21
      return [0x20, 0x21];
    },
    i2cWriteSync: (address: number, length: number, buffer: Buffer): void => {
      console.log(
        `Mock i2cWriteSync called with address 0x${address.toString(16)}, length ${length}, buffer [${buffer.toString()}]`
      );
    },
    i2cReadSync: (address: number, length: number, buffer: Buffer): number => {
      console.log(
        `Mock i2cReadSync called with address 0x${address.toString(16)}, length ${length}`
      );
      // Simulate reading by filling the buffer with dummy data
      buffer.fill(0xFF, 0, length);
      return length;
    },
    closeSync: (): void => {
      console.log('Mock closeSync called');
    },
  }),
};

// Export as CommonJS for compatibility with `require`
module.exports = i2cBusMock;
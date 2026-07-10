// filepath: /Users/cwd/Desktop/_code/ursa-science/projects/walkerLabs/wl_master/cron/src/types/i2c-bus.d.ts
declare module 'i2c-bus' {
  export interface I2CBus {
    openSync(busNumber: number): I2CBus;
    closeSync(): void;
    scanSync(startAddr?: number, endAddr?: number): number[];
    i2cWriteSync(addr: number, length: number, buffer: Buffer): number;
    i2cReadSync(addr: number, length: number, buffer: Buffer): number;
  }

  export function openSync(busNumber: number): I2CBus;
}

declare module './mocks/i2c-bus' {
  export interface I2CBus {
    openSync(busNumber: number): I2CBus;
    closeSync(): void;
    scanSync(startAddr?: number, endAddr?: number): number[];
    i2cWriteSync(addr: number, length: number, buffer: Buffer): number;
    i2cReadSync(addr: number, length: number, buffer: Buffer): number;
  }

  export function openSync(busNumber: number): I2CBus;
}
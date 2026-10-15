"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SDI12Commands = void 0;
class SDI12Commands {
    constructor(serialController) {
        this.serialController = serialController;
    }
    /**
     * @returns The SDI-12 firmware version.
     */
    async getDeviceInfo() {
        return this.serialController.sendCommand("zI");
    }
    /**
     * @returns The SDI-12 device address.
     */
    async getDeviceAddress() {
        return this.serialController.sendCommand("?");
    }
    /**
     * Sends an identification command to a sensor.
     * This is used for checking sensor existence.
     * @param address The sensor's SDI-12 address.
     * @returns The sensor's identification information.
     */
    async getSensorIdentification(address) {
        return this.serialController.sendCommand(`${address}I`);
    }
    /**
     * Initiates a measurement on the sensor at the given SDI-12 address.
     * @param address The sensor's SDI-12 address.
     */
    async startMeasurement(address) {
        return this.serialController.sendCommand(`${address}M`);
    }
    /**
     * Reads the measurement data from the sensor at the given SDI-12 address.
     * @param address The sensor's SDI-12 address.
     */
    async readMeasurementData(address) {
        return this.serialController.sendCommand(`${address}D0`);
    }
    /**
     * Changes the address of a sensor from the current address to a new address.
     * @param currentAddress The sensor's current SDI-12 address.
     * @param newAddress The desired new SDI-12 address.
     * @returns The new address if successful.
     */
    async changeSensorAddress(currentAddress, newAddress) {
        return this.serialController.sendCommand(`${currentAddress}A${newAddress}`);
    }
}
exports.SDI12Commands = SDI12Commands;

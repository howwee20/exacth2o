"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SerialControllerPool = void 0;
const serialController_1 = require("./serialController");
const usbDetector_1 = require("./usbDetector");
/**
 * SerialControllerPool manages a pool of SerialController instances,
 * ensuring only one controller per serial number is created and reused.
 */
class SerialControllerPool {
    constructor() {
        this.controllers = new Map();
        this.usbDetector = new usbDetector_1.USBDetector();
    }
    /**
     * Singleton accessor
     */
    static getInstance() {
        if (!SerialControllerPool.instance) {
            SerialControllerPool.instance = new SerialControllerPool();
        }
        return SerialControllerPool.instance;
    }
    /**
     * Get or create a SerialController for a given serial number.
     * Ensures only one controller per serial number is created and reused.
     */
    async getController(serialNumber) {
        let controller = this.controllers.get(serialNumber);
        if (!controller) {
            controller = new serialController_1.SerialController(this.usbDetector);
            await controller.openConnection(serialNumber);
            this.controllers.set(serialNumber, controller);
        }
        else {
            // Optionally, check if connection is open, and reopen if needed
            if (!controller.isOpen()) {
                await controller.openConnection(serialNumber);
            }
        }
        return controller;
    }
    /**
     * Release (close and remove) a controller for a given serial number.
     * Call this when you are done with a device.
     */
    async releaseController(serialNumber) {
        const controller = this.controllers.get(serialNumber);
        if (controller) {
            await controller.closeConnection();
            this.controllers.delete(serialNumber);
        }
    }
    /**
     * Close and remove all controllers (e.g., on shutdown)
     */
    async closeAll() {
        for (const [serial, controller] of this.controllers.entries()) {
            await controller.closeConnection();
        }
        this.controllers.clear();
    }
}
exports.SerialControllerPool = SerialControllerPool;

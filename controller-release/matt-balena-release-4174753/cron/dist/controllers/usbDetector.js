"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.USBDetector = void 0;
const usb = __importStar(require("usb"));
class USBDetector {
    constructor() {
        this.deviceSerialNumbers = {}; // Store serials
    }
    /**
     * List all connected USB devices.
     */
    listDevices() {
        console.log("Connected USB Devices:");
        const devices = usb.getDeviceList();
        if (devices.length === 0) {
            console.log("No USB devices detected.");
            return;
        }
        devices.forEach(device => {
            console.log(`VID: ${device.deviceDescriptor.idVendor.toString(16).toUpperCase()}, `
                + `PID: ${device.deviceDescriptor.idProduct.toString(16).toUpperCase()}`);
        });
    }
    /**
     * Find an SDI-12 adapter based on Vendor ID (VID) and Product ID (PID).
     * @returns The first detected SDI-12 adapter or null if not found.
     */
    async findSDI12Adapter() {
        const devices = usb.getDeviceList();
        const adapter = devices.find(device => Number(device.deviceDescriptor.idVendor) === Number(USBDetector.SDI12_VID)
        // && Number(device.deviceDescriptor.idProduct) === Number(USBDetector.SDI12_PID)
        );
        if (!adapter) {
            console.error("No SDI-12 adapter found.");
            return null;
        }
        console.log("SDI-12 adapter detected!");
        const serialNumber = await this.readSerialNumber(adapter);
        return { device: adapter, serialNumber };
    }
    /**
     * Finds all SDI-12 adapters based on Vendor ID and Product ID.
     * @returns An array of adapter objects containing the USB device and its serial number.
     */
    async findAllSDI12Adapters() {
        const devices = usb.getDeviceList();
        const adapters = [];
        console.log(`Found USB devices: ${JSON.stringify(devices.entries(), null, 2)}\n\nfiltering for SDI-12 adapters...`);
        const filteredDevices = devices.filter(device => device.deviceDescriptor.idVendor === USBDetector.SDI12_VID
        // && device.deviceDescriptor.idProduct === USBDetector.SDI12_PID
        );
        console.log(`Found ${filteredDevices.length} potential SDI-12 USB adapters`);
        for (const device of filteredDevices) {
            try {
                const serialNumber = await this.readSerialNumber(device);
                adapters.push({ device, serialNumber });
            }
            catch (error) {
                console.error("Error reading serial number for a device:", error);
            }
        }
        return adapters;
    }
    /**
     * Reads and stores the serial number of a given USB device.
     * @param device The USB device to read the serial number from.
     * @returns A Promise resolving to the serial number.
     */
    async readSerialNumber(device) {
        return new Promise((resolve, reject) => {
            if (!device) {
                reject("Invalid device provided.");
                return;
            }
            device.open();
            device.getStringDescriptor(device.deviceDescriptor.iSerialNumber, (err, serial) => {
                device.close();
                if (err) {
                    console.error("Error reading serial number:", err);
                    reject(err);
                    return;
                }
                if (!serial) {
                    console.warn("No serial number found for device.");
                    reject("No serial number found.");
                    return;
                }
                this.deviceSerialNumbers[serial] = serial; // Store for reference
                resolve(serial);
            });
        });
    }
    /**
     * Get all stored serial numbers of detected SDI-12 adapters.
     * @returns A list of stored serial numbers.
     */
    getStoredSerialNumbers() {
        return Object.values(this.deviceSerialNumbers);
    }
}
exports.USBDetector = USBDetector;
USBDetector.SDI12_VID = 0x0403; // FTDI Vendor ID
USBDetector.SDI12_PID = 0x6015; // FTDI Product ID (optional filter)

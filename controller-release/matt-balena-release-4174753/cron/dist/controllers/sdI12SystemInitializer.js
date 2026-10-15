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
exports.SDI12SystemInitializer = void 0;
// src/sdI12SystemInitializer.ts
const usbDetector_1 = require("./usbDetector"); // Corrected import path and class name
const serialController_1 = require("./serialController");
const serialControllerPool_1 = require("./serialControllerPool");
const sdI12Commands_1 = require("./sdI12Commands");
const fs = __importStar(require("fs"));
const constants_1 = require("../config/constants");
const soilData_1 = require("./utilities/soilData"); // Import SoilData if needed for verification
// Default empty configuration
const DEFAULT_CONFIG = {
    mappings: [],
    lastAssignedAddress: 0, // Index 0 corresponds to address '1'
};
/**
 * SDI12SystemInitializer handles the initialization of a multi-board SDI-12 system,
 * including detecting sensors and assigning unique addresses when conflicts exist.
 */
class SDI12SystemInitializer {
    /**
     * Creates a new SDI12SystemInitializer
     * @param configPath Path to the configuration file (defaults to 'sdi12-config.json')
     */
    constructor(configPath, apiService) {
        this.usbDetector = new usbDetector_1.USBDetector();
        // Use environment variable if available, otherwise use provided path or default
        this.configFilePath = configPath || process.env.SDI12_CONFIG_PATH || 'sdi12-config.json';
        console.log(`Using SDI-12 config file: ${this.configFilePath}`);
        this.config = this.loadOrInitializeConfig(); // Load or set default immediately
        this.apiService = apiService;
    }
    /**
     * Optionally inject or update ApiService after construction
     */
    setApiService(apiService) {
        this.apiService = apiService;
    }
    /**
     * Helper to post a log to the API if ApiService is available
     */
    async postLog(level, message, meta) {
        try {
            if (!this.apiService)
                return; // No-op if not wired
            await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                level,
                message,
                meta: meta !== null && meta !== void 0 ? meta : {}
            });
        }
        catch (e) {
            console.warn(`Failed to post initialization log (level: ${level}, message: ${message}):`, e);
        }
    }
    /**
     * Loads configuration from file or returns default. Handles errors gracefully.
     */
    loadOrInitializeConfig() {
        var _a, _b, _c, _d;
        console.log(`Attempting to load configuration from: ${this.configFilePath}`);
        if (fs.existsSync(this.configFilePath)) {
            try {
                const fileContent = fs.readFileSync(this.configFilePath, 'utf8');
                // Handle empty file case
                if (!fileContent.trim()) {
                    console.warn(`Configuration file '${this.configFilePath}' is empty. Using default configuration.`);
                    // Make sure DEFAULT_CONFIG includes lastAssignedAddress if required by interface
                    return { ...DEFAULT_CONFIG, lastAssignedAddress: (_a = DEFAULT_CONFIG.lastAssignedAddress) !== null && _a !== void 0 ? _a : -1 };
                }
                const parsedConfig = JSON.parse(fileContent);
                console.log(`DEBUG: Parsed config object: ${JSON.stringify(parsedConfig)}`); // Log the raw parsed object
                // --- Detailed Validation Checks ---
                let isValid = true;
                let validationError = "Unknown validation failure";
                if (typeof parsedConfig !== 'object' || parsedConfig === null) {
                    isValid = false;
                    validationError = "Config is not a non-null object.";
                }
                else if (!Array.isArray(parsedConfig.mappings)) {
                    isValid = false;
                    validationError = "'mappings' property is missing or not an array.";
                }
                else if (typeof parsedConfig.lastAssignedAddress !== 'number') {
                    // If lastAssignedAddress is optional, this check might need adjustment
                    // Assuming it's required for now based on SystemConfig interface
                    isValid = false;
                    validationError = `'lastAssignedAddress' property is missing or not a number. Found type: ${typeof parsedConfig.lastAssignedAddress}`;
                }
                else if (!parsedConfig.mappings.every((m, index) => {
                    // Deeper check for each mapping object
                    if (typeof m !== 'object' || m === null) {
                        validationError = `Mapping at index ${index} is not an object.`;
                        return false;
                    }
                    if (typeof m.boardSerial !== 'string' || !m.boardSerial) { // Added check for empty string
                        validationError = `Mapping at index ${index} has missing/invalid 'boardSerial'.`;
                        return false;
                    }
                    if (!Array.isArray(m.sensorAddresses)) {
                        validationError = `Mapping for board ${m.boardSerial} has missing/invalid 'sensorAddresses' (not an array).`;
                        return false;
                    }
                    if (!m.sensorAddresses.every((addr) => typeof addr === 'string' && addr.length === 1)) { // Check for single char string
                        validationError = `Mapping for board ${m.boardSerial} has non-string or non-single-char address in 'sensorAddresses'. Problematic address: ${m.sensorAddresses.find((addr) => typeof addr !== 'string' || addr.length !== 1)}`;
                        return false;
                    }
                    return true; // This mapping seems valid
                })) {
                    // If .every() returned false, validationError was set inside the callback
                    isValid = false;
                }
                // --- End Detailed Validation Checks ---
                if (isValid) {
                    console.log("Successfully loaded and validated configuration from file.");
                    // Ensure lastAssignedAddress is valid (-1 or >= 0)
                    parsedConfig.lastAssignedAddress = Math.max(-1, parsedConfig.lastAssignedAddress);
                    return parsedConfig;
                }
                else {
                    console.warn(`Configuration file '${this.configFilePath}' has invalid format or missing keys. Validation Error: ${validationError}. Using default configuration.`);
                    return { ...DEFAULT_CONFIG, lastAssignedAddress: (_b = DEFAULT_CONFIG.lastAssignedAddress) !== null && _b !== void 0 ? _b : -1 };
                }
            }
            catch (error) {
                console.error(`Error reading or parsing configuration file '${this.configFilePath}': ${error}. Using default configuration.`);
                return { ...DEFAULT_CONFIG, lastAssignedAddress: (_c = DEFAULT_CONFIG.lastAssignedAddress) !== null && _c !== void 0 ? _c : -1 };
            }
        }
        else {
            console.log(`Configuration file '${this.configFilePath}' not found. Initializing with default configuration.`);
            return { ...DEFAULT_CONFIG, lastAssignedAddress: (_d = DEFAULT_CONFIG.lastAssignedAddress) !== null && _d !== void 0 ? _d : -1 };
        }
    }
    /**
     * Saves the current configuration to the config file
     */
    saveConfig() {
        try {
            // Ensure config is valid before saving (should be due to constructor)
            if (!this.config || typeof this.config !== 'object' || !Array.isArray(this.config.mappings)) {
                console.error("Attempted to save invalid configuration state. Aborting save.");
                return;
            }
            fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2));
            console.log(`Configuration saved successfully to ${this.configFilePath}`);
        }
        catch (error) {
            console.error(`Failed to save configuration to ${this.configFilePath}:`, error);
        }
    }
    // --- ALL METHODS BELOW MUST BE INSIDE THE CLASS ---
    /**
     * Verifies if a sensor can actually provide measurement data
     * @param sdi12 SDI12Commands instance
     * @param address The sensor address to verify
     * @returns true if the sensor responds with valid data, false otherwise
     */
    async verifySensorMeasurement(sdi12, address) {
        try {
            console.log(`Verifying measurement capability for sensor ${address}...`);
            // Start measurement
            const measureResponse = await sdi12.startMeasurement(address);
            // Sensor might return just the address if it needs no time, or 'atttn'
            console.log(`Sensor ${address} measure response: "${measureResponse}"`);
            // Extract expected time 'ttt' - add a buffer. Handle cases where 'ttt' is 0 or response is short.
            let waitTimeMs = 2000;
            // Check a stricter 'atttn' format (address, 3 digits time, 1 digit count)
            if (measureResponse && measureResponse.length >= 5 && measureResponse.startsWith(address) && /^\d{3}\d$/.test(measureResponse.substring(1))) {
                const timeEstimate = parseInt(measureResponse.substring(1, 4), 10);
                // Add buffer, ensure minimum wait time in case estimate is very low (e.g., 0)
                waitTimeMs = Math.max(500, timeEstimate * 1000) + 500;
                console.log(`Sensor ${address} estimated ${timeEstimate}s. Waiting ${waitTimeMs}ms.`);
            }
            else if (measureResponse && measureResponse.length === 1 && measureResponse === address) {
                // Sensor responded with address only, implying immediate data readiness (or error)
                console.log(`Sensor ${address} responded immediately. Setting short wait time.`);
                waitTimeMs = 500; // Short wait for immediate readiness cases
            }
            else {
                console.warn(`Sensor ${address} measure response format unexpected: "${measureResponse}". Using default wait time.`);
            }
            // Wait for measurement to complete
            await new Promise(resolve => setTimeout(resolve, waitTimeMs));
            // Read data
            console.log(`Attempting to read measurement data from sensor ${address}...`);
            const data = await sdi12.readMeasurementData(address);
            console.log(`Sensor ${address} raw measurement data: "${data}"`);
            // Verify data format using SoilData constructor
            try {
                new soilData_1.SoilData(data); // Attempt to parse
                console.log(`Sensor ${address} data format verified successfully.`);
                return true;
            }
            catch (parseError) { // Catch specific error type if possible
                console.warn(`Sensor ${address} returned data in an unexpected format: "${data}". Parse error: ${(parseError === null || parseError === void 0 ? void 0 : parseError.message) || parseError}`);
                return false;
            }
        }
        catch (error) {
            // Check if the error is a timeout specific to readMeasurementData or startMeasurement
            const errorMessage = (error === null || error === void 0 ? void 0 : error.message) || String(error);
            if (errorMessage.includes("Timeout")) {
                console.warn(`Sensor ${address} timed out during measurement sequence.`, error);
            }
            else {
                console.warn(`Sensor ${address} failed measurement verification command:`, error);
            }
            return false;
        }
    }
    /**
     * Detects all boards and finds sensors, attempting to resolve address '0' conflicts.
     * @param thoroughVerification If true, performs a full measurement test on each potentially found sensor.
     * @param assignAddresses If true, assigns addresses (calls changeSensorAddress); if false, skips address assignment.
     * @returns A map of board serial numbers to arrays of detected & verified sensor addresses (potentially including temporary ones).
     */
    async detectAllSensors(thoroughVerification = false, assignAddresses = true) {
        const finalResults = new Map();
        const adapters = await this.usbDetector.findAllSDI12Adapters();
        if (!adapters.length) { /* ... no adapters ... */
            console.log("No SDI-12 adapters detected. Exiting detection process.");
            return finalResults;
        }
        console.log(`Detected ${adapters.length} potential SDI-12 boards. Scanning and assigning addresses locally...`);
        const temporaryAddressStartCode = 'a'.charCodeAt(0);
        const temporaryAddressEndCode = 'z'.charCodeAt(0);
        // Use shared constant for full SDI-12 address set
        const boardAddressPool = [...constants_1.SDI12_ADDRESS_POOL];
        for (const adapter of adapters) {
            const serialController = await serialControllerPool_1.SerialControllerPool.getInstance().getController(adapter.serialNumber);
            console.log(`\nProcessing board ${adapter.serialNumber}...`);
            await this.postLog('info', 'SDI-12 board scan started', { boardSerial: adapter.serialNumber });
            let parserRef = null;
            const portPath = await serialController.findSerialPort(adapter.serialNumber);
            if (!portPath) { /* ... no port ... */
                continue;
            }
            let nextTempCharCode = temporaryAddressStartCode;
            const tempAddressesFound = [];
            const standardAddressesFound = [];
            const finalAssignedAddresses = [];
            try {
                await serialController.openConnection(adapter.serialNumber);
                parserRef = serialController.getParser();
                if (parserRef)
                    parserRef.setMaxListeners(30);
                console.log("  Initial wait after connection open...");
                await new Promise(resolve => setTimeout(resolve, 1500));
                const sdi12 = new sdI12Commands_1.SDI12Commands(serialController);
                // --- Step 1: Handle Address '0' ---
                console.log(`  Checking for sensors at address 0 (0I! first)...`);
                let zeroCheckIteration = 0;
                const MAX_ZERO_CHECKS = 10;
                while (zeroCheckIteration < MAX_ZERO_CHECKS) {
                    zeroCheckIteration++;
                    let foundSensorAtZero = false;
                    let identifiedBy = '';
                    console.log(`  [0-Check ${zeroCheckIteration}] ---`);
                    try {
                        try { /* Try 0I! */
                            await sdi12.getSensorIdentification("0");
                            foundSensorAtZero = true;
                            identifiedBy = '0I!';
                            console.log(`    Found sensor at 0 via 0I!.`);
                        }
                        catch (identifyError) { /* 0I failed */
                            const identifyErrorMsg = (identifyError === null || identifyError === void 0 ? void 0 : identifyError.message) || String(identifyError);
                            if (!identifyErrorMsg.includes('Timeout'))
                                console.warn(`  0I! check error: ${identifyErrorMsg}`);
                            console.log(`    0I! failed/timed out. Trying M/D fallback...`);
                            try { /* Try M/D Fallback */
                                await new Promise(resolve => setTimeout(resolve, 200));
                                await sdi12.startMeasurement("0");
                                await new Promise(resolve => setTimeout(resolve, 1000));
                                const dataResponse = await sdi12.readMeasurementData("0");
                                // *** MODIFIED CHECK FOR M/D RESPONSE ***
                                // Check if response exists, starts with '0', and contains a '+' or '-' after the initial 0
                                // Tolerant of initial garbage like '0/Nx0' before the first sign.
                                if (dataResponse && dataResponse.startsWith('0') && /[+-]/.test(dataResponse.substring(1))) {
                                    console.log(`    [Fallback] Received plausible data from address 0 via M/D: "${dataResponse}".`);
                                    foundSensorAtZero = true;
                                    identifiedBy = 'M/D Fallback';
                                }
                                else {
                                    console.log(`    [Fallback] M/D response not valid data ("${dataResponse}"). Both methods failed.`);
                                    break; // Exit while loop
                                }
                            }
                            catch (mdError) { /* M/D Failed */
                                const mdErrorMsg = (mdError === null || mdError === void 0 ? void 0 : mdError.message) || String(mdError);
                                if (!mdErrorMsg.includes('Timeout'))
                                    console.warn(`  [Fallback] M/D sequence error: ${mdErrorMsg}`);
                                console.log(`    [Fallback] M/D sequence failed/timed out. Both methods failed.`);
                                break; // Exit while loop
                            }
                        } // End of initial 0I! catch block
                        // --- Process if found ---
                        if (foundSensorAtZero) {
                            if (nextTempCharCode > temporaryAddressEndCode) {
                                console.error("    Ran out of temp addresses (a-z).");
                                break;
                            }
                            const tempAddr = String.fromCharCode(nextTempCharCode);
                            console.log(`    Moving sensor from 0 to temp '${tempAddr}' (Identified by ${identifiedBy})...`);
                            try { /* Try changing 0 -> temp */
                                await sdi12.changeSensorAddress("0", tempAddr);
                                await new Promise(resolve => setTimeout(resolve, 25000));
                                try { /* Try verifying temp addr */
                                    await sdi12.getSensorIdentification(tempAddr);
                                    console.log(`      Successfully moved 0 -> ${tempAddr} (verified).`);
                                    tempAddressesFound.push(tempAddr);
                                    nextTempCharCode++;
                                }
                                catch (verifyTempError) {
                                    console.error(`      Failed to verify sensor at temp address ${tempAddr}. Stopping 0-check.`, verifyTempError);
                                    break;
                                }
                            }
                            catch (changeError) {
                                console.error(`      Error sending change address command (0 -> ${tempAddr}). Stopping 0-check.`, changeError);
                                break;
                            }
                        }
                        else {
                            break;
                        } // No sensor found at 0 this iteration
                        await new Promise(resolve => setTimeout(resolve, 300)); // Wait before next 0 check
                    }
                    catch (outerError) { /* Catch unexpected errors */
                        console.error(`[0-Check ${zeroCheckIteration}] Error: ${(outerError === null || outerError === void 0 ? void 0 : outerError.message) || outerError}`);
                        break;
                    }
                } // End of while loop
                if (zeroCheckIteration >= MAX_ZERO_CHECKS)
                    console.warn("  Reached max iterations checking address 0.");
                console.log(`  Finished checking address 0. Found temp addresses: [${tempAddressesFound.join(', ')}]`);
                await this.postLog('info', 'Address 0 handling complete', {
                    boardSerial: adapter.serialNumber,
                    tempAddressesFound
                });
                // --- Add small delay before scanning full address range ---
                console.log("  Waiting before scanning 0-9,A-Z,a-z...");
                await new Promise(resolve => setTimeout(resolve, 500));
                // --- Step 2: Scan Standard Addresses (0-9, A-Z, a-z) ---
                console.log(`  Scanning standard addresses (0-9,A-Z,a-z)...`);
                for (const address of boardAddressPool) {
                    if (tempAddressesFound.includes(address))
                        continue;
                    try {
                        await sdi12.getSensorIdentification(address);
                        console.log(`    Found sensor at standard address ${address}`);
                        standardAddressesFound.push(address);
                    }
                    catch ( /* No sensor */_a) { /* No sensor */ }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                console.log(`  Finished scanning full range. Found standard addresses: [${standardAddressesFound.join(', ')}]`);
                await this.postLog('info', 'Standard address scan complete', {
                    boardSerial: adapter.serialNumber,
                    standardAddressesFound
                });
                // --- Step 3: Assign Final Addresses (0-9,A-Z,a-z) ---
                const allDetected = [...standardAddressesFound, ...tempAddressesFound];
                const totalSensorsFound = allDetected.length;
                if (assignAddresses) {
                    console.log(`  Assigning final addresses for ${totalSensorsFound} detected sensors...`);
                    await this.postLog('info', 'Assigning final addresses', {
                        boardSerial: adapter.serialNumber,
                        totalSensorsFound
                    });
                    if (totalSensorsFound > boardAddressPool.length) {
                        /* ... handle too many sensors ... */
                        await serialController.closeConnection();
                        continue;
                    }
                    let boardPoolIndex = 0;
                    for (const currentAddress of allDetected) {
                        const targetAddress = boardAddressPool[boardPoolIndex];
                        if (currentAddress === targetAddress) {
                            console.log(`    Sensor already at correct final address ${currentAddress}.`);
                            finalAssignedAddresses.push(currentAddress);
                            boardPoolIndex++;
                        }
                        else {
                            console.log(`    Attempting final assignment: '${currentAddress}' -> '${targetAddress}'`);
                            await this.postLog('info', 'Address assignment attempt', {
                                boardSerial: adapter.serialNumber,
                                from: currentAddress,
                                to: targetAddress
                            });
                            try {
                                const assigned = await this.performAddressChange(serialController, sdi12, currentAddress, targetAddress);
                                console.log(`      Successfully assigned final address ${assigned}`);
                                finalAssignedAddresses.push(assigned);
                                boardPoolIndex++;
                                await this.postLog('info', 'Address assignment success', {
                                    boardSerial: adapter.serialNumber,
                                    from: currentAddress,
                                    to: assigned
                                });
                            }
                            catch (assignmentError) {
                                console.error(`      Failed final assignment: ${currentAddress} -> ${targetAddress}. Sensor skipped. Error: ${assignmentError}`);
                                await this.postLog('error', 'Address assignment failed', {
                                    boardSerial: adapter.serialNumber,
                                    from: currentAddress,
                                    to: targetAddress,
                                    error: String(assignmentError)
                                });
                            }
                        }
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                    console.log(`  Finished assignment phase. Successfully assigned addresses: [${finalAssignedAddresses.join(', ')}]`);
                    await this.postLog('info', 'Final address assignment complete', {
                        boardSerial: adapter.serialNumber,
                        assigned: finalAssignedAddresses
                    });
                }
                else {
                    // If not assigning addresses, just use detected addresses as-is
                    finalAssignedAddresses.push(...allDetected);
                    console.log(`  Skipping address assignment. Using detected addresses: [${finalAssignedAddresses.join(', ')}]`);
                }
                // --- Step 4: Thorough Verification (on final addresses) ---
                let verifiedFinalAddresses = [];
                if (thoroughVerification && finalAssignedAddresses.length > 0) {
                    /* ... verification logic ... */
                    // (Same as before - iterate finalAssignedAddresses, call verifySensorMeasurement)
                    console.log(`  Performing measurement verification on final addresses: [${finalAssignedAddresses.join(', ')}]`);
                    for (const finalAddr of finalAssignedAddresses) {
                        if (await this.verifySensorMeasurement(sdi12, finalAddr)) {
                            verifiedFinalAddresses.push(finalAddr);
                        }
                        else {
                            console.warn(`    Sensor at final address ${finalAddr} failed measurement verification - excluding.`);
                        }
                    }
                    console.log(`  Finished verification. Verified addresses: [${verifiedFinalAddresses.join(', ')}]`);
                    await this.postLog('info', 'Verification complete', {
                        boardSerial: adapter.serialNumber,
                        verified: verifiedFinalAddresses,
                        attempted: finalAssignedAddresses
                    });
                }
                else {
                    verifiedFinalAddresses = [...finalAssignedAddresses];
                    console.log("  Skipping measurement verification step.");
                }
                // --- Store Results ---
                if (verifiedFinalAddresses.length > 0) {
                    finalResults.set(adapter.serialNumber, verifiedFinalAddresses.sort());
                }
                else {
                    console.log(`  No sensors verified or assigned for board ${adapter.serialNumber}.`);
                    await this.postLog('warn', 'No sensors verified or assigned for board', { boardSerial: adapter.serialNumber });
                }
            }
            catch (error) { /* ... Major error handling ... */
                throw error;
            }
            finally { /* ... Close connection ... */ }
        } // End of loop through adapters
        console.log(`\nSensor detection and local assignment complete. Final results ready for ${finalResults.size} boards.`);
        await this.postLog('info', 'Board scan and local assignment complete', { boardsWithResults: finalResults.size });
        return finalResults;
    }
    async performAddressChange(serialController, // Pass controller if needed, or just sdi12 object
    sdi12, currentAddress, newAddress) {
        var _a;
        // Simplified verification: ensure target is clear (optional but good)
        try {
            await sdi12.getSensorIdentification(newAddress);
            throw new Error(`Target address ${newAddress} already occupied.`);
        }
        catch (e) {
            if (!((_a = e.message) === null || _a === void 0 ? void 0 : _a.includes('Timeout')))
                console.warn(` Pre-check for target ${newAddress} gave unexpected error: ${e.message}`);
        } // Expect timeout
        // Send change command
        await sdi12.changeSensorAddress(currentAddress, newAddress);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Pause
        // Verify new address
        try {
            await sdi12.getSensorIdentification(newAddress);
            await this.postLog('info', 'performAddressChange success', { from: currentAddress, to: newAddress });
            return newAddress; // Success
        }
        catch (verifyError) {
            console.error(`    Verification failed after change command (${currentAddress} -> ${newAddress}).`, verifyError);
            await this.postLog('error', 'performAddressChange verification failed', {
                from: currentAddress,
                to: newAddress,
                error: String(verifyError)
            });
            // Try checking old address?
            await new Promise(resolve => setTimeout(resolve, 200));
            try {
                await sdi12.getSensorIdentification(currentAddress);
                throw new Error(`Sensor still at old address ${currentAddress}.`);
            }
            catch (_b) {
                throw new Error(`Sensor lost after failed change to ${newAddress}.`);
            }
        }
    }
    /**
     * Verifies configured boards/sensors against current detection results.
     * Updates the configuration primarily by removing mappings for boards that are no longer detected.
     * Relies on detectAllSensors(true) to provide the list of currently verified sensors.
     * @returns true if configuration was updated, false otherwise
     */
    async verifyAndUpdateConfig(assignAddresses) {
        var _a;
        console.log(`\n=== Verifying Existing Sensor Configuration ===`);
        const currentConfig = this.getSystemConfig(); // Get potentially loaded config
        if (!currentConfig.mappings || currentConfig.mappings.length === 0) {
            console.log("No existing configuration mappings to verify.");
            return false;
        }
        console.log("Performing detection scan with verification to compare against configuration...");
        // Detect all currently connected sensors with thorough verification
        const detectedSensorMap = await this.detectAllSensors(true, assignAddresses); // Returns map of boardSerial -> [verified addresses]
        console.log(`\nVerification scan complete. Comparing ${currentConfig.mappings.length} configured board(s) against detection results...`);
        let configChanged = false;
        const newMappings = []; // Build the updated list
        const detectedBoardSerials = new Set(detectedSensorMap.keys());
        // Iterate through the boards listed in the *current configuration*
        for (const configuredMapping of currentConfig.mappings) {
            const boardSerial = configuredMapping.boardSerial;
            const configuredAddresses = configuredMapping.sensorAddresses;
            console.log(`\nVerifying configured board ${boardSerial} (Sensors: ${configuredAddresses.join(', ') || 'None'})...`);
            // Check if the configured board was found in the *detection* results
            if (detectedBoardSerials.has(boardSerial)) {
                console.log(`- Board ${boardSerial} was detected.`);
                // Simple verify: If board is present, keep its configured mapping.
                newMappings.push(configuredMapping); // Keep the original mapping
                console.log(`- Keeping configuration for board ${boardSerial}.`);
            }
            else {
                // The board listed in the config was NOT detected in the scan
                configChanged = true;
                console.warn(`- Configured board ${boardSerial} was NOT detected. Removing its mapping from configuration.`);
            }
        } // End loop through configured mappings
        // Check if any *new* boards were detected that are not in the config
        for (const detectedSerial of detectedBoardSerials) {
            if (!currentConfig.mappings.some(m => m.boardSerial === detectedSerial)) {
                console.warn(`- New board ${detectedSerial} detected with sensors: [${(_a = detectedSensorMap.get(detectedSerial)) === null || _a === void 0 ? void 0 : _a.join(', ')}]. It's not in the current config. Run 'init' to include it.`);
                // Do not automatically add new boards during verify
            }
        }
        // Update the configuration object and save if changes were made
        if (configChanged) {
            console.log("\nConfiguration changes detected during verification.");
            this.config.mappings = newMappings; // Update the internal config object
            this.saveConfig(); // Save the modified configuration
            console.log(`Configuration updated.`);
            return true;
        }
        else {
            console.log(`\nConfiguration verification complete. No changes needed.`);
            return false;
        }
    }
    /**
     * Changes a sensor's address
     * @param boardSerial The serial number of the board
     * @param currentAddress The current address of the sensor
     * @param newAddress The desired new address for the sensor
     * @returns The new address if successful
     * @throws Error if the change fails or verification fails
     */
    async changeSensorAddress(boardSerial, currentAddress, newAddress) {
        var _a;
        console.log(`Attempting to change sensor address from ${currentAddress} to ${newAddress} on board ${boardSerial}`);
        // Note: The check for currentAddress === newAddress is handled by the caller (initializeSystem/detectAllSensors)
        const serialController = new serialController_1.SerialController(this.usbDetector);
        try {
            await serialController.openConnection(boardSerial);
            console.log("  Waiting after connection open for address change...");
            await new Promise(resolve => setTimeout(resolve, 1500)); // Wait after opening
            const sdi12 = new sdI12Commands_1.SDI12Commands(serialController);
            // 1. Verify current address (optional but good) - simplified for this context
            try {
                console.log(`  Verifying sensor presence at current address ${currentAddress}...`);
                await sdi12.getSensorIdentification(currentAddress);
            }
            catch (verifyError) {
                console.warn(`  Warning: Sensor didn't respond at current address ${currentAddress} before change attempt: ${verifyError === null || verifyError === void 0 ? void 0 : verifyError.message}`);
                // Proceed with caution? Or throw? Let's proceed for now.
            }
            // 2. Verify target is clear (optional but good)
            try {
                await sdi12.getSensorIdentification(newAddress);
                throw new Error(`Target address ${newAddress} already occupied.`);
            }
            catch (e) {
                if (!((_a = e.message) === null || _a === void 0 ? void 0 : _a.includes('Timeout')))
                    console.warn(`  Warning: Pre-check for target ${newAddress} gave unexpected error: ${e.message}`);
            }
            // 3. Send change command
            console.log(`  Sending address change command: ${currentAddress} -> ${newAddress}`);
            await sdi12.changeSensorAddress(currentAddress, newAddress); // Assume command doesn't return useful data reliably
            // 4. Verify new address
            await new Promise(resolve => setTimeout(resolve, 1000)); // Pause
            try {
                console.log(`  Verifying sensor presence at new address ${newAddress}...`);
                await sdi12.getSensorIdentification(newAddress);
                console.log(`  Address change successful: Sensor confirmed at ${newAddress}.`);
                return newAddress; // Success!
            }
            catch (finalVerifyError) {
                console.error(`  Address change FAILED: Sensor not responding at new address ${newAddress}.`, finalVerifyError);
                // Try checking old address again?
                await new Promise(resolve => setTimeout(resolve, 500));
                try {
                    await sdi12.getSensorIdentification(currentAddress);
                    throw new Error(`Sensor may still be at old address ${currentAddress}.`);
                }
                catch (_b) {
                    throw new Error(`Sensor lost after failed change to ${newAddress}.`);
                }
            }
        }
        catch (error) {
            console.error(`Error during sensor address change execution:`, error);
            throw error; // Re-throw to allow caller to handle it
        }
        finally {
            await serialController.closeConnection();
        }
    }
    /**
     * Checks if there are address conflicts *within* the provided map (detects duplicates).
     * This is used by initializeSystem *before* assigning permanent addresses.
     * @param detectedSensors Map of board serials to arrays of detected sensor addresses (potentially temporary).
     * @returns true if any address appears more than once across all boards, false otherwise.
     */
    hasAddressConflicts(detectedSensors) {
        const allAddresses = [];
        for (const addresses of detectedSensors.values()) {
            allAddresses.push(...addresses);
        }
        const uniqueAddresses = new Set(allAddresses);
        const hasConflict = uniqueAddresses.size < allAddresses.length;
        if (hasConflict) {
            // Find duplicates for logging
            const counts = allAddresses.reduce((acc, addr) => {
                acc[addr] = (acc[addr] || 0) + 1;
                return acc;
            }, {});
            const duplicates = Object.entries(counts)
                .filter(([addr, count]) => count > 1)
                .map(([addr, count]) => `${addr} (x${count})`);
            console.warn(`Address conflicts detected among scanned sensors: ${duplicates.join(', ')}`);
        }
        return hasConflict;
    }
    /**
     * Initializes the system by detecting all sensors, resolving conflicts, and assigning unique addresses.
    * @param startAddressNum (Deprecated param) Previously first numeric address (1-9). Now full pool is fixed (0-9,A-Z,a-z) and startAddressNum is ignored.
     * @returns The updated system configuration
     */
    async initializeSystem(assignAddresses) {
        console.log(`\n=== Starting SDI-12 System Initialization ===`);
        console.log("Detecting sensors and assigning board-local addresses (0-9,A-Z,a-z)...");
        await this.postLog('info', 'SDI-12 initialization started');
        // Step 1: Detect sensors and perform local assignment/verification
        const finalSensorMap = await this.detectAllSensors(true, assignAddresses);
        console.log(`\nDetection and local assignment complete. Found verified sensors on ${finalSensorMap.size} boards.`);
        await this.postLog('info', 'SDI-12 detection complete', { boardsDetected: finalSensorMap.size });
        if (finalSensorMap.size === 0) {
            console.log("No boards with verified sensors detected. Saving empty configuration.");
            await this.postLog('warn', 'No boards with verified sensors detected. Saving empty configuration.');
            this.config = { mappings: [], lastAssignedAddress: -1 };
            this.saveConfig();
            await this.postLog('info', 'SDI-12 initialization completed', { boardsConfigured: 0, sensorsConfigured: 0 });
            return this.config;
        }
        // Step 2: Build configuration directly from the results
        console.log("Building final configuration...");
        this.config = {
            mappings: [],
            lastAssignedAddress: -1 // Mark as not applicable or 0
        };
        let totalSensors = 0;
        for (const [boardSerial, finalAddresses] of finalSensorMap.entries()) {
            if (finalAddresses.length > 0) {
                this.config.mappings.push({
                    boardSerial,
                    sensorAddresses: finalAddresses // Already sorted 1-N from detectAllSensors
                });
                totalSensors += finalAddresses.length;
                console.log(`  Added board ${boardSerial} with addresses: [${finalAddresses.join(', ')}]`);
                await this.postLog('info', 'Board configured', { boardSerial, sensorAddresses: finalAddresses });
            }
        }
        // Set lastAssignedAddress based on whether *any* mappings were added
        this.config.lastAssignedAddress = this.config.mappings.length > 0 ? 0 : -1;
        // Step 3: Save the final configuration
        this.saveConfig();
        console.log(`\n=== System Initialization Complete ===`);
        console.log(`Configured ${this.config.mappings.length} boards. Total verified sensors: ${totalSensors}.`);
        await this.postLog('info', 'SDI-12 initialization completed', { boardsConfigured: this.config.mappings.length, sensorsConfigured: totalSensors });
        return this.config;
    }
    /**
     * Updates the address for a specific sensor on a specific board within the loaded configuration object.
     * Does NOT save the configuration to disk.
     * @param boardSerial The serial number of the board.
     * @param oldAddress The address being replaced.
     * @param newAddress The new address to set.
     * @returns true if the update was successful, false otherwise (e.g., board or sensor not found).
     */
    updateConfigMapping(boardSerial, oldAddress, newAddress) {
        if (!this.config || !this.config.mappings) {
            console.error("Error updating config: Configuration not loaded properly.");
            return false;
        }
        const mappingIndex = this.config.mappings.findIndex(m => m.boardSerial === boardSerial);
        if (mappingIndex === -1) {
            console.error(`Error updating config: Board ${boardSerial} not found in configuration.`);
            return false;
        }
        const sensorIndex = this.config.mappings[mappingIndex].sensorAddresses.indexOf(oldAddress);
        if (sensorIndex === -1) {
            console.error(`Error updating config: Sensor address ${oldAddress} not found for board ${boardSerial}.`);
            return false;
        }
        // Update the address
        this.config.mappings[mappingIndex].sensorAddresses[sensorIndex] = newAddress;
        // Optional: Sort the addresses array after modification
        this.config.mappings[mappingIndex].sensorAddresses.sort();
        console.log(`Configuration mapping updated in memory for board ${boardSerial}: ${oldAddress} -> ${newAddress}`);
        return true;
    }
    /**
     * Gets the current system configuration safely.
     * @returns The current system configuration (guaranteed to be a valid object).
     */
    getSystemConfig() {
        // Constructor ensures this.config is always initialized
        return this.config;
    }
    /**
     * Gets all sensor addresses across all boards from the current config.
     * @returns Array of all configured sensor addresses.
     */
    getAllSensorAddresses() {
        const addresses = [];
        const config = this.getSystemConfig();
        if (config === null || config === void 0 ? void 0 : config.mappings) { // Add null check for safety
            for (const mapping of config.mappings) {
                if (Array.isArray(mapping.sensorAddresses)) { // Check if it's an array
                    addresses.push(...mapping.sensorAddresses);
                }
            }
        }
        return addresses;
    }
    /**
     * Gets the mapping of sensors to a specific board from the current config.
     * @param boardSerial The serial number of the board.
     * @returns The sensor addresses for the board, or null if board not found in config.
     */
    getBoardSensorAddresses(boardSerial) {
        var _a;
        const config = this.getSystemConfig();
        const mapping = (_a = config.mappings) === null || _a === void 0 ? void 0 : _a.find(m => m.boardSerial === boardSerial);
        // Return a copy or null, ensure sensorAddresses is valid array
        return (mapping && Array.isArray(mapping.sensorAddresses)) ? [...mapping.sensorAddresses] : null;
    }
    /**
     * Gets all board serial numbers present in the current config.
     * @returns Array of all configured board serial numbers.
     */
    getAllBoardSerials() {
        var _a;
        const config = this.getSystemConfig();
        return ((_a = config.mappings) === null || _a === void 0 ? void 0 : _a.map(mapping => mapping.boardSerial)) || []; // Return empty array if no mappings
    }
    /**
     * Gets a mapping of all boards to their sensors from the current config.
     * @returns A map of board serial numbers to arrays of sensor addresses.
     */
    getBoardSensorMap() {
        const map = new Map();
        const config = this.getSystemConfig();
        if (config === null || config === void 0 ? void 0 : config.mappings) {
            for (const mapping of config.mappings) {
                // Ensure addresses is an array before spreading, return a copy
                map.set(mapping.boardSerial, Array.isArray(mapping.sensorAddresses) ? [...mapping.sensorAddresses] : []);
            }
        }
        return map;
    }
} // End class SDI12SystemInitializer
exports.SDI12SystemInitializer = SDI12SystemInitializer;

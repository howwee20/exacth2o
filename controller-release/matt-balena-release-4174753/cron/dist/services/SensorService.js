"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SensorService = void 0;
const sdI12SystemManager_1 = require("../controllers/sdI12SystemManager");
const sdI12SystemInitializer_1 = require("../controllers/sdI12SystemInitializer");
const constants_1 = require("../config/constants");
/**
 * Service responsible for managing sensor operations
 */
class SensorService {
    constructor(apiService) {
        this.apiService = apiService;
        this.sensorManager = undefined;
        this.lastSetupAttempt = 0;
        this.setupRetryCount = 0;
        this.SETUP_RETRY_LIMIT = 3;
        this.SETUP_RETRY_DELAY = 30000; // 30 seconds between retries
        this.sensorManager = new sdI12SystemManager_1.SDI12SystemManager();
    }
    async setupSensorConfigs(assignAddresses) {
        try {
            console.log('Setup configurations for sensors');
            if (this.sensorManager) {
                console.log('Reusing existing SDI12SystemManager instance and reinitializing it');
                this.sensorManager.setInitializer(new sdI12SystemInitializer_1.SDI12SystemInitializer(undefined, this.apiService));
            }
            else {
                console.log('Creating new SDI12SystemManager instance');
                this.sensorManager = new sdI12SystemManager_1.SDI12SystemManager();
            }
            console.log('Running SDI12SystemManager initialization');
            const sysInit = this.sensorManager.getInitializer();
            // Ensure ApiService is wired for logging with proper typing
            sysInit.setApiService(this.apiService);
            const config = await sysInit.initializeSystem(assignAddresses);
            console.log('SDI12SystemManager initialized', config);
            for (const entry of config.mappings) {
                const { boardSerial, sensorAddresses } = entry;
                console.log(`Processing configured board with Serial Number: ${boardSerial}`);
                for (let i = 0; i < sensorAddresses.length; ++i) {
                    const sensorId = sensorAddresses[i];
                    console.log(`Creating sensor ${sensorId} in API: ${sensorId}`);
                    await this.apiService.postData(constants_1.API_ENDPOINTS.SENSORS, {
                        "name": `sensor-${sensorId}`,
                        "type": "SDI12",
                        "description": `sensor #${sensorId} at boardSerial #${boardSerial}`,
                        "address": sensorId,
                        "boardSerialId": boardSerial,
                    });
                    await this.apiService.postData(constants_1.API_ENDPOINTS.LOGS, {
                        "level": "info",
                        "message": `Sensor ${sensorId} at boardSerial ${boardSerial} created or already exists`,
                        "meta": { boardSerial, sensorId }
                    });
                }
            }
            console.log('✅ Sensor configurations saved successfully');
            // Reset retry count on success
            this.setupRetryCount = 0;
            return true;
        }
        catch (error) {
            console.error('❌ Error setting up sensor configurations:', error);
            return false;
        }
    }
    async operateSensor(boardSerial, sensorAddress, measurements = 1) {
        const data = [];
        if (!this.sensorManager) {
            console.error('SensorManager is not initialized. Cannot operate sensor.');
            throw new Error('SensorManager is not initialized. Cannot operate sensor.');
        }
        try {
            for (let i = 0; i < measurements; ++i) {
                console.log(`Operating sensor ${sensorAddress} on board ${boardSerial}`);
                const sensorData = await this.sensorManager.getSpecificSensorData(boardSerial, sensorAddress);
                if (sensorData) {
                    console.log(`${i}: Sensor data for ${sensorAddress} on board ${boardSerial}: ${JSON.stringify(sensorData, null, 2)}`);
                    data.push(sensorData);
                }
                else {
                    console.error(`${i}: Failed to get data from sensor ${sensorAddress} on board ${boardSerial}`);
                }
            }
            return data;
        }
        catch (error) {
            console.error(`Error operating sensor ${sensorAddress} on board ${boardSerial}:`, error);
            return null;
        }
    }
    /**
     * Safely attempts to setup sensor configurations with retry logic and rate limiting
     */
    async safeSetupSensorConfigs(assignAddresses) {
        const now = Date.now();
        // Check if we've exceeded retry limit
        if (this.setupRetryCount >= this.SETUP_RETRY_LIMIT) {
            console.error(`❌ Sensor setup failed ${this.SETUP_RETRY_LIMIT} times. Giving up until next restart.`);
            return false;
        }
        // Rate limiting: don't retry too frequently
        if (now - this.lastSetupAttempt < this.SETUP_RETRY_DELAY) {
            const waitTime = this.SETUP_RETRY_DELAY - (now - this.lastSetupAttempt);
            console.warn(`⏳ Sensor setup rate limited. Next attempt in ${Math.round(waitTime / 1000)}s`);
            return false;
        }
        console.log(`🔄 Attempting sensor setup (attempt ${this.setupRetryCount + 1}/${this.SETUP_RETRY_LIMIT})`);
        this.lastSetupAttempt = now;
        this.setupRetryCount++;
        const success = await this.setupSensorConfigs(assignAddresses);
        if (!success) {
            console.error(`❌ Sensor setup attempt ${this.setupRetryCount} failed`);
        }
        return success;
    }
    /**
     * Checks if sensors are working and runs full initialization if not
     */
    async checkSensorHealth() {
        // Early exit if sensor manager not initialized
        if (!this.sensorManager) {
            console.log('SensorManager not initialized, running setup...');
            return await this.safeSetupSensorConfigs(false);
        }
        try {
            console.log('Checking sensor health...');
            // Check both adapters and configuration in parallel
            const adapters = await this.sensorManager.getAllAdapters();
            const boardSensorMap = this.sensorManager.getInitializer().getBoardSensorMap();
            // Fail if no adapters or empty configuration
            if (adapters.length === 0 || boardSensorMap.size === 0) {
                const reason = adapters.length === 0 ? 'No SDI-12 adapters detected' : 'Sensor configuration is empty (boardSensorMap has no entries)';
                console.log(`❌ ${reason}, running full sensor initialization...`);
                return await this.safeSetupSensorConfigs(false);
            }
            console.log(`✅ Found ${adapters.length} SDI-12 adapter(s) and ${boardSensorMap.size} configured board(s), sensors appear healthy`);
            // Log current configuration for debugging
            for (const [boardSerial, sensors] of boardSensorMap.entries()) {
                console.log(`   - Board ${boardSerial}: sensors [${sensors.join(', ')}]`);
            }
            return true;
        }
        catch (error) {
            console.error('❌ Sensor health check failed, running full sensor initialization...', error);
            return await this.safeSetupSensorConfigs(false);
        }
    }
    /**
     * Calibrates a raw sensor value using a polynomial defined by the given coefficients.
     *
     * @param {string} coefficientsString - A comma-separated string of numbers representing the polynomial coefficients.
     *   The coefficients correspond to terms of the polynomial in ascending order of degree.
     *   For example, "0,3,6,0,3" represents the polynomial y = 0 + 3x + 6x² + 0x³ + 3x⁴.
     * @param {number} rawValue - The raw sensor value to be calibrated.
     * @returns {number} - The calibrated value obtained by evaluating the polynomial at the given raw value.
     */
    calibrateRawData(coefficientsString, rawValue) {
        const coefficients = (coefficientsString || '0,1').split(',').map((str, idx) => {
            const coeff = Number(str.trim());
            if (isNaN(coeff)) {
                console.warn(`Invalid coefficient at index ${idx}: "${str}". It will be ignored.`);
                return NaN;
            }
            return coeff;
        }).filter(coeff => !isNaN(coeff));
        const polynomial = (x) => coefficients.reduceRight((acc, coeff) => acc * x + coeff, 0);
        return polynomial(rawValue);
    }
}
exports.SensorService = SensorService;

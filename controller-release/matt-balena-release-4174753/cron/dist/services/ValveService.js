"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValveService = void 0;
const Expand13Manager_1 = require("../controllers/Expand13Manager");
const Expand13Controller_1 = require("../controllers/Expand13Controller");
const constants_1 = require("../config/constants");
/**
 * Service responsible for managing valve operations
 */
class ValveService {
    constructor(apiService) {
        this.apiService = apiService;
        this.valveManager = undefined;
        this.pinStates = new Map();
        this.valveBoardConfigs = [];
    }
    async setupValveConfigs() {
        let valveNumber = 1;
        for (let boardIndex = 0; boardIndex < this.valveBoardConfigs.length; ++boardIndex) {
            const config = this.valveBoardConfigs[boardIndex];
            console.log(`Initializing board: ${config.address}`);
            for (let pin = 0; pin < constants_1.VALVE_CONFIGURATION.ROWS; ++pin) {
                for (let column = 0; column < constants_1.VALVE_CONFIGURATION.COLS; ++column) {
                    this.pinStates.set(this.calculatePinAddress(column, pin), false);
                    console.log(`creating valve ${valveNumber} in API: at location ${config.address}/#0x${config.address.toString(16)}: [${column}][${pin}]`);
                    this.operateValve(config.address, column, pin, 'CLOSE');
                    await this.apiService.postData(constants_1.API_ENDPOINTS.VALVES, {
                        "name": `valve-${valveNumber}`,
                        "description": `valve #${valveNumber} at on board ${boardIndex}/#0x${config.address.toString(16)}: pin [${column}][${pin}]`,
                        "address": `${(pin) * constants_1.VALVE_CONFIGURATION.COLS + (column + 1)}`,
                        "relayAddress": `0x${config.address.toString(16)}`,
                    });
                    ++valveNumber;
                }
            }
        }
    }
    operateValve(boardAddress, column, pin, state) {
        if (this.valveManager) {
            try {
                console.log(`Operating valve on board ${boardAddress}: [${column}][${pin}] state: ${state}`);
                this.valveManager.setMultiplePinsOnBoard(boardAddress, [{ column, pin, active: state === 'OPEN' }]);
            }
            catch (error) {
                console.error(`Error operating valve on board ${boardAddress}:`, error);
                throw new Error(`Failed to operate valve on board ${boardAddress}: ${error.message}`);
            }
        }
        else {
            console.error(`ValveManager is not initialized. Cannot operate valve on board ${boardAddress}.`);
            throw new Error(`ValveManager is not initialized. Cannot operate valve on board ${boardAddress}.`);
        }
    }
    calculatePinAddress(column, pin) {
        return (column) * constants_1.VALVE_CONFIGURATION.ROWS + (pin + 1);
    }
    calculateColumnAndPin(address) {
        const column = Math.floor((address - 1) / constants_1.VALVE_CONFIGURATION.ROWS);
        const pin = (address - 1) % constants_1.VALVE_CONFIGURATION.ROWS;
        return { column, pin };
    }
    getValveBoardConfigs(scanForAddresses = false) {
        let valveBoardConfigs = this.valveBoardConfigs;
        console.log('Getting valve board configurations');
        if (scanForAddresses) {
            const addresses = Expand13Controller_1.Expand13Controller.scanForAddresses(1);
            console.log('Found addresses:', addresses);
            if (addresses.length === 0) {
                console.warn('No addresses found on the I2C bus. Using default board configurations.');
                // Return default configs - will be set by caller
            }
            else {
                console.log('Using found addresses for board configurations:', addresses);
                valveBoardConfigs = addresses.map(address => ({ address, resetPin: 16 }));
            }
        }
        return valveBoardConfigs;
    }
    async setBoardConfigs(boardConfigs, updateAPI = false) {
        if (this.valveManager) {
            try {
                // Clean up if needed
            }
            catch (error) {
                console.error('Error cleaning up valve manager:', error);
                return false;
            }
        }
        console.log('Setting board configurations:', boardConfigs);
        this.valveBoardConfigs = boardConfigs;
        this.valveManager = new Expand13Manager_1.Expand13ControllerManager(boardConfigs);
        console.log('Board configurations set:', boardConfigs);
        if (updateAPI) {
            console.log('Updating board configurations in API');
            await this.apiService.postData(constants_1.API_ENDPOINTS.BOARD_CONFIGS, boardConfigs);
            console.log('Board configurations updated in API');
        }
        return true;
    }
    getBoardConfigs() {
        return this.valveBoardConfigs;
    }
    closeAllValves() {
        if (!this.valveManager) {
            throw new Error('ValveManager is not initialized. Cannot close valves.');
        }
        console.log('Closing all valves...');
        const failures = [];
        const boards = this.getBoardConfigs();
        for (const board of boards) {
            for (let column = 0; column < constants_1.VALVE_CONFIGURATION.COLS; ++column) {
                for (let pin = 0; pin < constants_1.VALVE_CONFIGURATION.ROWS; ++pin) {
                    try {
                        this.operateValve(board.address, column, pin, 'CLOSE');
                    }
                    catch (error) {
                        failures.push(`${board.address}:${column}:${pin}: ${(error === null || error === void 0 ? void 0 : error.message) || String(error)}`);
                    }
                }
            }
        }
        if (failures.length > 0) {
            throw new Error(`Failed to close ${failures.length} valve outputs: ${failures.join('; ')}`);
        }
        console.log('All valves closed.');
    }
}
exports.ValveService = ValveService;

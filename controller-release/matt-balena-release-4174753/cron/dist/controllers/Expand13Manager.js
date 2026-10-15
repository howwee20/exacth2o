"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Expand13ControllerManager = void 0;
const Expand13Controller_1 = require("./Expand13Controller");
const I2C_BUS_NUMBER = 1; // Default I2C bus number
class Expand13ControllerManager {
    /**
     * @param boardConfigs An array of board configurations.
     * @param busNumber The I²C bus number for all boards (default is 1).
     */
    constructor(boardConfigs, busNumber = I2C_BUS_NUMBER) {
        this.busNumber = busNumber;
        this.controllers = [];
        boardConfigs.forEach(config => {
            const controller = new Expand13Controller_1.Expand13Controller(this.busNumber, config.address, config.resetPin);
            this.controllers.push(controller);
            console.log(`Initialized board at address 0x${config.address.toString(16)}${config.resetPin !== undefined ? ` with reset on GPIO${config.resetPin}` : ''}.`);
        });
    }
    /**
     * Retrieve the controller for a given I²C address.
     */
    getController(address) {
        return this.controllers.find(ctrl => ctrl.address === address);
    }
    /**
     * Send commands to a specific board.
     */
    setMultiplePinsOnBoard(address, commands) {
        const controller = this.getController(address);
        if (controller) {
            controller.setMultiplePins(commands);
        }
        else {
            console.error(`Controller for address 0x${address.toString(16)} not found.`);
            throw new Error(`Controller for address 0x${address.toString(16)} not found.`);
        }
    }
    /**
     * Broadcast commands to multiple boards.
     * Each command should include the board's I²C address.
     */
    broadcastCommands(commands) {
        commands.forEach(cmd => {
            const controller = this.getController(cmd.address);
            if (controller) {
                controller.setMultiplePins([{ column: cmd.column, pin: cmd.pin, active: cmd.active }]);
            }
            else {
                console.error(`Controller for address 0x${cmd.address.toString(16)} not found.`);
            }
        });
    }
    /**
     * Call cleanup on all controllers.
     */
    cleanupAll() {
        this.controllers.forEach(ctrl => ctrl.cleanup());
    }
}
exports.Expand13ControllerManager = Expand13ControllerManager;

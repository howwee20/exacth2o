"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
const StateMachine_1 = __importDefault(require("./StateMachine"));
const apiURL = ((_a = process.env) === null || _a === void 0 ? void 0 : _a.API_URL) || 'http://localhost:3000';
const stateMachine = new StateMachine_1.default(apiURL);
const main = async () => {
    await stateMachine.init();
    // Start the event loop
    while (stateMachine.pairingsLoaded() === false) {
        console.log('+');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    stateMachine.start();
    // Periodically log the state of all pairings
    const startTime = Date.now();
    setInterval(() => {
        const pairings = stateMachine.getAllPairingStates();
        // pairings.forEach(pairing => {
        //   console.log(`${Date.now() - startTime}) Pairing: ${pairing.sensorId}-${pairing.valveId}, state: ${pairing.state} [next transition: ${pairing.nextTransitionTime}]`);
        // });
    }, 1000);
};
main();

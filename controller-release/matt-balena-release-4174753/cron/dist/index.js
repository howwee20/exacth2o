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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("fs/promises");
const path_1 = __importDefault(require("path"));
const StateMachine_1 = __importDefault(require("./StateMachine"));
const server_1 = require("./server");
const devtools = __importStar(require("./debugCron"));
const BOOTUP_INIT = (process.env.BOOTUP_INIT === 'true') || false;
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const ENABLE_FAKE_DATA = process.env.ENABLE_FAKE_DATA === 'true';
const INIT_FILE = process.env.INIT_FILE || `${path_1.default.join(__dirname, '..', 'init.json')}`;
const apiURL = ((_a = process.env) === null || _a === void 0 ? void 0 : _a.API_URL) || 'http://localhost:3000';
const PORT = Number((_b = process.env) === null || _b === void 0 ? void 0 : _b.PORT) || 3000;
const pathPrefix = 'v1';
const stateMachine = new StateMachine_1.default(apiURL);
const server = (0, server_1.createServer)(stateMachine, { environment: ENVIRONMENT, port: PORT, apiURL, pathPrefix });
let shuttingDown = false;
const gracefulShutdown = async (signal) => {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.log(`Received ${signal}; closing active valves before exit`);
    try {
        await Promise.race([
            stateMachine.shutdown(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timed out')), 10000)),
        ]);
    }
    catch (error) {
        console.error('Graceful shutdown encountered an error:', error);
    }
    try {
        await server.close();
    }
    finally {
        process.exit(0);
    }
};
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
const main = async () => {
    let init = false;
    let initFileContents = { lastStartTime: new Date().toISOString(), pairings: [] };
    if (BOOTUP_INIT) {
        //check for existence of initialization file and read it
        const initFileExists = await (0, promises_1.stat)(INIT_FILE).then(() => true).catch(() => false);
        if (initFileExists) {
            console.log(`Initialization file ${INIT_FILE} exists. Reading...`);
            const initConfig = await (0, promises_1.readFile)(INIT_FILE, 'utf-8');
            initFileContents = JSON.parse(initConfig);
            console.log('Skipping state machine initialization. Init file contents:', initFileContents);
        }
        else {
            console.log(`Initialization file ${INIT_FILE} does not exist. Running state machine with initialization.`); // If the init file does not exist, we can assume that the state machine should be initialized with initialization
        }
        init = !initFileExists; // If the file does not exist, we need to initialize the state machine
    }
    try {
        await stateMachine.init(init);
        console.log('State machine initialized.');
        // while (!stateMachine.pairingsLoaded()) {
        //   console.log('*')
        //   await new Promise(resolve => setTimeout(resolve, 1000))
        // }
        // console.log('Pairings loaded. Starting state machine.')
        await stateMachine.start();
        console.log('State machine started.');
        //save init file
        initFileContents.lastStartTime = new Date().toISOString();
        initFileContents.pairings = stateMachine.getAllPairingStates();
        console.log('Saving initialization file:', initFileContents);
        await (0, promises_1.writeFile)(INIT_FILE, JSON.stringify(initFileContents, null, 2), 'utf-8');
        console.log('Initialization file saved.');
    }
    catch (error) {
        console.error('Error initializing state machine:', error);
        server.log.error({ err: error }, 'Error initializing state machine');
        process.exit(1);
    }
};
server.listen({ host: '::', port: PORT }, (err, address) => {
    if (err) {
        server.log.error(err);
        process.exit(1);
    }
    server.log.info(`server listening on ${address}`);
});
server.ready((err) => {
    if (err) {
        server.log.error(err);
        process.exit(1);
    }
    console.log('Server is ready. Starting main function...');
    main().catch((error) => {
        console.error('Error starting state machine:', error);
        server.log.error('Error starting state machine:', error);
        process.exit(1);
    });
});
if (ENVIRONMENT === 'local' && ENABLE_FAKE_DATA) {
    // run the debug cron
    devtools.fakeDataInsertLoop();
}

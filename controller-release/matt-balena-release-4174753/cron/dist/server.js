"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const types_1 = require("./types");
const crypto_1 = require("crypto");
const getSensors = async (stateMachine, boardSerialId, sensorAddress, measurements) => {
    try {
        console.log(`Calling statemachine to operateSensor(boardSerialId: ${boardSerialId}, sensorAddress: ${sensorAddress}, measurements: ${measurements})`);
        const sensor = await stateMachine.operateSensor(boardSerialId, sensorAddress, measurements);
        if (sensor) {
            return { message: `boardSerialId: ${boardSerialId},sensor: ${sensorAddress}`, data: sensor };
        }
        else {
            throw new Error('Sensor not found');
        }
    }
    catch (error) {
        throw new Error('Internal Server Error');
    }
};
const operateValve = async (stateMachine, relayAddress, address, state) => {
    const boardAddress = Number.parseInt(relayAddress, 16);
    const { pin, column } = stateMachine.calculateColumnAndPin(address);
    try {
        await stateMachine.operateValve(boardAddress, column, pin, state);
        return { message: `Valve ${state} command sent to relay ${relayAddress}, address ${address}` };
    }
    catch (error) {
        throw new Error('Internal Server Error');
    }
};
const operateState = async (stateMachine, state) => {
    try {
        await stateMachine.setState(state);
        return { message: `State ${state} command sent` };
    }
    catch (error) {
        throw new Error('Internal Server Error');
    }
};
/**
 * Creates a Fastify server with the given state machine and options.
 * @param {StateMachine} stateMachine - The state machine instance.
 * @param {Object} options - The options for the server.
 * @param {string} options.environment - The environment (development, production, test).
 * @param {number} options.port - The port to listen on.
 * @param {string} options.apiURL - The API URL.
 * @param {string} options.pathPrefix - The path prefix for the API routes.
 * @returns {FastifyInstance} - The Fastify server instance.
 */
function createServer(stateMachine, options) {
    var _a;
    const { environment, pathPrefix } = options;
    const envToLogger = {
        development: {
            transport: {
                target: 'pino-pretty',
                options: {
                    translateTime: 'HH:MM:ss Z',
                    ignore: 'pid,hostname',
                },
            },
        },
        production: true,
        test: false,
    };
    const server = (0, fastify_1.default)({
        logger: (_a = envToLogger[environment]) !== null && _a !== void 0 ? _a : true
    });
    server.register(cors_1.default, {
        origin: true,
    });
    const controllerSecret = String(process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET || '');
    const hasControllerSecret = (request) => {
        const supplied = String(request.headers['x-exacth2o-controller-secret'] || '');
        if (!controllerSecret || !supplied)
            return false;
        const expectedBuffer = Buffer.from(controllerSecret);
        const suppliedBuffer = Buffer.from(supplied);
        return expectedBuffer.length === suppliedBuffer.length && (0, crypto_1.timingSafeEqual)(expectedBuffer, suppliedBuffer);
    };
    const requireControllerSecret = (request, reply) => {
        if (hasControllerSecret(request))
            return true;
        reply.status(401).send({ message: 'Controller command authentication required' });
        return false;
    };
    server.get(`/${pathPrefix}/sensors`, async (request, reply) => {
        var _a;
        const { boardSerialId, sensorAddress } = request.query;
        const measurements = ((_a = request.query) === null || _a === void 0 ? void 0 : _a.measurements) || 1;
        try {
            const sensor = await getSensors(stateMachine, boardSerialId, sensorAddress, measurements);
            return reply.status(200).send(sensor);
        }
        catch (error) {
            server.log.error(error);
            return reply.status(500).send({ message: 'Internal Server Error' });
        }
    });
    server.post(`/${pathPrefix}/valves`, async (request, reply) => {
        if (!requireControllerSecret(request, reply))
            return;
        const { relayAddress, address, state } = request.body;
        if (state !== 'CLOSE') {
            return reply.status(410).send({
                message: 'Untimed valve OPEN is disabled. Use the authenticated pulse route.',
            });
        }
        try {
            const resp = await operateValve(stateMachine, relayAddress, address, state);
            return reply.status(200).send(resp);
        }
        catch (error) {
            server.log.error(error);
            reply.code(500).send({ message: 'Internal Server Error' });
        }
    });
    server.post(`/${pathPrefix}/valves/pulse`, async (request, reply) => {
        if (!requireControllerSecret(request, reply))
            return;
        const body = request.body || {};
        const relayAddress = typeof body.relayAddress === 'string'
            ? Number.parseInt(body.relayAddress, body.relayAddress.toLowerCase().startsWith('0x') ? 16 : 10)
            : Number(body.relayAddress);
        const address = Number(body.address);
        const durationMilliseconds = Number(body.durationMilliseconds);
        const pulseId = String(body.pulseId || '').trim();
        const commandId = String(body.commandId || '').trim();
        if (!Number.isInteger(relayAddress) || relayAddress < 0 || relayAddress > 0x7f) {
            return reply.status(400).send({ message: 'relayAddress is invalid' });
        }
        if (!Number.isInteger(address) || address < 1 || address > 32) {
            return reply.status(400).send({ message: 'address is invalid' });
        }
        if (!Number.isInteger(durationMilliseconds) || durationMilliseconds < 1 || durationMilliseconds > 60000) {
            return reply.status(400).send({ message: 'durationMilliseconds must be between 1 and 60000' });
        }
        if (!pulseId || pulseId.length > 240 || !commandId || commandId.length > 120) {
            return reply.status(400).send({ message: 'pulseId and commandId are required' });
        }
        try {
            const result = await stateMachine.pulseManualValve({
                relayAddress,
                address,
                durationMilliseconds,
                pulseId,
                commandId,
            });
            return reply.status(result.duplicate ? 200 : 202).send({
                ok: true,
                failSafe: 'controller_owned_timer',
                ...result,
            });
        }
        catch (error) {
            server.log.error(error);
            const message = (error === null || error === void 0 ? void 0 : error.message) || 'Manual pulse rejected';
            const conflict = message.includes('already') || message.includes('another valve') || message.includes('aggregate');
            return reply.status(conflict ? 409 : 500).send({ message });
        }
    });
    server.post(`/${pathPrefix}/valves/hold`, async (request, reply) => {
        const expected = process.env.EXACTH2O_MANUAL_HOLD_SECRET || '';
        const supplied = String(request.headers['x-exacth2o-hold-secret'] || '');
        if (!expected || supplied.length !== expected.length || !(0, crypto_1.timingSafeEqual)(Buffer.from(supplied), Buffer.from(expected)))
            return reply.code(401).send({ error: 'Hold authentication required' });
        const body = request.body || {};
        if (!['start', 'renew', 'stop', 'status'].includes(body.action))
            return reply.code(400).send({ error: 'Invalid hold action' });
        if (!Number.isInteger(body.address) || body.address < 1 || body.address > 48 || !Number.isInteger(body.relayAddress) || body.relayAddress < 3 || body.relayAddress > 127)
            return reply.code(400).send({ error: 'Invalid valve route' });
        if (!Number.isInteger(body.sensorId) || !Number.isInteger(body.valveId))
            return reply.code(400).send({ error: 'Invalid pot identity' });
        try {
            return await stateMachine.holdManualValve(body.action, body);
        }
        catch (error) {
            return reply.code(409).send({ error: error.message || 'Hold rejected' });
        }
    });
    server.get(`/${pathPrefix}/state`, async (request, reply) => {
        try {
            const state = stateMachine.getState();
            return reply.status(200).send({ message: 'State retrieved successfully', data: state });
        }
        catch (error) {
            server.log.error(error);
            return reply.status(500).send({ message: 'Internal Server Error' });
        }
    });
    server.get(`/${pathPrefix}/boardConfigs`, async (request, reply) => {
        try {
            const boardConfigs = stateMachine.getBoardConfigs();
            return reply.status(200).send({ message: 'Board configs retrieved successfully', data: boardConfigs });
        }
        catch (error) {
            server.log.error(error);
            return reply.status(500).send({ message: 'Internal Server Error' });
        }
    });
    server.post(`/${pathPrefix}/boardConfigs`, async (request, reply) => {
        if (!requireControllerSecret(request, reply))
            return;
        const { boardConfigs } = request.body;
        console.log('Received boardConfigs:', boardConfigs);
        try {
            if (!Array.isArray(boardConfigs)) {
                return reply.status(400).send({ message: 'Invalid boardConfigs' });
            }
            await stateMachine.setBoardConfigs(boardConfigs);
            return reply.status(200).send({ message: 'Board configs updated successfully', data: boardConfigs });
        }
        catch (error) {
            server.log.error(error);
            return reply.status(500).send({ message: 'Internal Server Error' });
        }
    });
    server.post(`/${pathPrefix}/state`, async (request, reply) => {
        if (!requireControllerSecret(request, reply))
            return;
        const { state, boardConfig } = request.body;
        console.log('state', state);
        console.log('boardConfig', boardConfig);
        try {
            if (!state) {
                console.error('State is required');
                // Log the error to the server log
                return reply.status(400).send({ message: 'State is required' });
            }
            if (!Object.values(types_1.MachineState).includes(state)) {
                console.error('Invalid state value:', state);
                return reply.status(400).send({ message: `Invalid state value: ${state}` });
            }
            if (boardConfig && !Array.isArray(boardConfig)) {
                console.error('Invalid boardConfig:', boardConfig);
                // Log the error to the server log
                return reply.status(400).send({ message: 'Invalid boardConfig' });
            }
            if (boardConfig) {
                // Set the board configs in the state machine
                console.log('Setting board configs:', boardConfig);
                await stateMachine.setBoardConfigs(boardConfig);
            }
            let desiredState = types_1.MachineState.STOPPED;
            switch (state) {
                case types_1.MachineState.STARTUP:
                    desiredState = types_1.MachineState.STARTUP;
                    break;
                case types_1.MachineState.RUNNING:
                    desiredState = types_1.MachineState.RUNNING;
                    break;
                case types_1.MachineState.STOPPED:
                    desiredState = types_1.MachineState.STOPPED;
                    break;
                case types_1.MachineState.UPDATE:
                    desiredState = types_1.MachineState.UPDATE;
                    break;
                case types_1.MachineState.RESET:
                    desiredState = types_1.MachineState.RESET;
                    break;
            }
            try {
                // Attempt to set the state in the state machine
                const resp = await operateState(stateMachine, desiredState);
                return reply.status(200).send(resp);
            }
            catch (error) {
                console.error('Error setting state in state machine:', error);
                server.log.error(error);
                return reply.status(500).send({ message: `Internal Server Error: ${error.message}` });
            }
        }
        catch (error) {
            server.log.error(error);
            return reply.status(500).send({ message: 'Internal Server Error' });
        }
    });
    return server;
}

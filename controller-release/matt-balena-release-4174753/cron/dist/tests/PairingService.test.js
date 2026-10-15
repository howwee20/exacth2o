"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockApiService = void 0;
const ApiService_1 = require("../services/ApiService");
const PairingService_1 = require("../services/PairingService");
// Mock API Service for testing
class MockApiService extends ApiService_1.ApiService {
    constructor() {
        super('http://mock-api.com');
        this.mockData = {};
    }
    setMockData(endpoint, data) {
        this.mockData[endpoint] = data;
    }
    async fetchData(endpoint) {
        return this.mockData[endpoint] || [];
    }
    async postData(endpoint, data) {
        console.log(`Mock POST to ${endpoint}:`, data);
        return { success: true, data };
    }
}
exports.MockApiService = MockApiService;
// Example test
describe('PairingService', () => {
    it('should fetch and process pairings correctly', async () => {
        // Arrange
        const mockApiService = new MockApiService();
        const pairingService = new PairingService_1.PairingService(mockApiService, 1000);
        const mockPairings = [
            {
                sensorId: 1,
                valveId: 1,
                groupId: 1,
                name: 'Test Pairing',
                WTCPercentLimit: 50,
                ValveOpenTime: 5000,
                MeasurementInterval: 60000,
                Sensor: { id: 1, address: '1', type: 'SDI12', description: 'Test Sensor', name: 'sensor-1', boardSerialId: 'BOARD001', createdAt: '2023-01-01', updatedAt: '2023-01-01' },
                Valve: { id: 1, address: '1', relayAddress: '0x20', description: 'Test Valve', name: 'valve-1', createdAt: '2023-01-01', updatedAt: '2023-01-01' },
                createdAt: '2023-01-01',
                updatedAt: '2023-01-01'
            }
        ];
        mockApiService.setMockData('/v1/pairings', mockPairings);
        // Act
        await pairingService.fetchPairings();
        // Assert
        const allPairings = pairingService.getAllPairings();
        expect(allPairings).toHaveLength(1);
        expect(allPairings[0].sensorId).toBe(1);
        expect(allPairings[0].valveId).toBe(1);
        expect(allPairings[0].state).toBe('STARTUP');
        expect(pairingService.isPairingsFetched()).toBe(true);
    });
    it('should retrieve pairing by sensor and valve ID', () => {
        // Arrange
        const mockApiService = new MockApiService();
        const pairingService = new PairingService_1.PairingService(mockApiService, 1000);
        // Add a test pairing directly
        const testPairing = {
            sensorId: 1,
            valveId: 2,
            groupId: 1,
            name: 'Test Pairing',
            WTCPercentLimit: 30,
            ValveOpenTime: 3000,
            MeasurementInterval: 30000,
            Sensor: { id: 1, address: '1', type: 'SDI12', description: 'Test Sensor', name: 'sensor-1', boardSerialId: 'BOARD001', createdAt: '2023-01-01', updatedAt: '2023-01-01' },
            Valve: { id: 2, address: '2', relayAddress: '0x20', description: 'Test Valve', name: 'valve-2', createdAt: '2023-01-01', updatedAt: '2023-01-01' },
            createdAt: '2023-01-01',
            updatedAt: '2023-01-01'
        };
        pairingService.addPairing(testPairing, {
            measurementTime: 1000,
            startDelayTime: 1000,
            delayTime: 1000,
            valveOpenTime: 3000,
            intervalTime: 30000
        }, 30);
        // Act
        const retrievedPairing = pairingService.getPairing('1', '2');
        // Assert
        expect(retrievedPairing).toBeDefined();
        expect(retrievedPairing === null || retrievedPairing === void 0 ? void 0 : retrievedPairing.sensorId).toBe(1);
        expect(retrievedPairing === null || retrievedPairing === void 0 ? void 0 : retrievedPairing.valveId).toBe(2);
        expect(retrievedPairing === null || retrievedPairing === void 0 ? void 0 : retrievedPairing.WTCPercentLimit).toBe(30);
    });
});

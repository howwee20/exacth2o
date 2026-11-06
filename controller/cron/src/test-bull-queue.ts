import { BullQueueService } from './services/BullQueueService'
import { PairingState, PairingStateType } from './types/system'

async function testBullQueue() {
  console.log('Testing Bull Queue Service...')

  const queueService = new BullQueueService({
    host: 'localhost',
    port: 6379
  })

  let processedCount = 0
  queueService.setEventProcessor(async (event) => {
    processedCount++
    console.log(`Processed event ${processedCount}: ${event.pairing.sensorId}-${event.pairing.valveId} -> ${event.newState}`)
  })

  const mockPairing: PairingState = {
    sensorId: 1,
    valveId: 1,
    groupId: 1,
    name: 'Test Pairing',
    ValveOpenTime: 10000,
    MeasurementInterval: 60000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'IDLE' as PairingStateType,
    nextTransitionTime: Date.now(),
    WTCPercentLimit: 50,
    WTCPercentMeasured: 0,
    lastMeasurementAt: Date.now(),
    previousWTCPercentMeasured: null,
    previousMeasurementAt: null,
    measurementValid: true,
    wateringMeasurementValid: true,
    valveOpened: false,
    lastValveOpenedAt: null,
    wateringWindowStartedAt: null,
    wateringWindowPulseCount: 0,
    timingRules: {
      measurementTime: 5000,
      startDelayTime: 1000,
      delayTime: 2000,
      valveOpenTime: 10000,
      intervalTime: 60000
    },
    Sensor: {
      id: 1,
      name: 'Test Sensor',
      type: 'temperature',
      description: 'Test sensor for Bull queue',
      address: '0x01',
      boardSerialId: 'test-board',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    Valve: {
      id: 1,
      name: 'Test Valve',
      description: 'Test valve for Bull queue',
      address: '1',
      relayAddress: '192.168.1.1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    Calibration: {
      id: 1,
      name: 'Test Calibration',
      readingsJSONString: '[]',
      polynomialCoefficientsCommaDelimited: '0,1'
    }
  }

  console.log('Queuing test events...')
  queueService.queueStateTransition(mockPairing, 'MEASURING')
  queueService.queueStateTransition(mockPairing, 'DELAY')
  queueService.queueStateTransition(mockPairing, 'VALVE_OPEN')

  await queueService.processQueue()

  console.log('Waiting for events to process...')
  await new Promise(resolve => setTimeout(resolve, 3000))

  const queueLength = await queueService.getQueueLength()
  console.log(`Current queue length: ${queueLength}`)
  console.log(`Total processed: ${processedCount}`)

  await queueService.close()
  console.log('Bull Queue test complete!')
}

if (require.main === module) {
  testBullQueue().catch(console.error)
}

export { testBullQueue }

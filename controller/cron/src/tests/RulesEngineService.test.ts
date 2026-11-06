import { RulesEngineService } from '../services/RulesEngineService'

async function transitionFor(facts: Record<string, unknown>): Promise<string[]> {
  const engine = new RulesEngineService()
  const { events } = await engine.evaluateRules(facts)
  return events.map(event => event.params?.newState)
}

const dueFacts = {
  nextTransitionTime: 1000,
  currentTime: 1000,
  measurementTime: 210000,
  delayTime: 30000,
  valveOpenTime: 3000,
  intervalTime: 600000,
  measurementValid: false,
  wateringEnabled: false,
  wateringMeasurementValid: false,
  wateringShouldOpen: false,
  WTCPercentMeasured: null,
  WTCPercentLimit: 20,
}

describe('RulesEngineService safety transitions', () => {
  it('moves failed measurements to SENSOR_FAULT', async () => {
    await expect(transitionFor({
      ...dueFacts,
      state: 'MEASURING',
      measurementValid: false,
    })).resolves.toEqual(['SENSOR_FAULT'])
  })

  it('moves valid measurements to DELAY', async () => {
    await expect(transitionFor({
      ...dueFacts,
      state: 'MEASURING',
      measurementValid: true,
    })).resolves.toEqual(['DELAY'])
  })

  it('opens only when watering is enabled and the band decision says to water', async () => {
    await expect(transitionFor({
      ...dueFacts,
      state: 'DELAY',
      wateringEnabled: true,
      wateringMeasurementValid: true,
      wateringShouldOpen: true,
      WTCPercentMeasured: 12.5,
      WTCPercentLimit: 20,
    })).resolves.toEqual(['VALVE_OPEN'])
  })

  it('returns to idle without close commands when the band decision says not to water', async () => {
    await expect(transitionFor({
      ...dueFacts,
      state: 'DELAY',
      wateringEnabled: true,
      wateringMeasurementValid: true,
      wateringShouldOpen: false,
      WTCPercentMeasured: 35,
      WTCPercentLimit: 20,
    })).resolves.toEqual(['IDLE'])
  })

  it('returns measurement-only disabled watering to idle', async () => {
    await expect(transitionFor({
      ...dueFacts,
      state: 'DELAY',
      wateringEnabled: false,
      wateringMeasurementValid: false,
      WTCPercentMeasured: null,
      WTCPercentLimit: -999999,
    })).resolves.toEqual(['IDLE'])
  })

  it('fails closed when watering is enabled but the measurement is invalid for watering', async () => {
    await expect(transitionFor({
      ...dueFacts,
      state: 'DELAY',
      wateringEnabled: true,
      wateringMeasurementValid: false,
      WTCPercentMeasured: null,
      WTCPercentLimit: 20,
    })).resolves.toEqual(['SENSOR_FAULT'])
  })
})

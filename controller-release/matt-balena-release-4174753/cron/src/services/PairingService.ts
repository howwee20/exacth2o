import { IPairing, PairingState, TimingSet } from '../types/system'
import { ApiService } from './ApiService'
import { API_ENDPOINTS, DEFAULT_TIMING } from '../config/constants'

/**
 * Service responsible for managing pairing data and state
 */
export class PairingService {
  private pairings: Map<string, PairingState> = new Map()
  private pairingsFetched: boolean = false

  constructor(private apiService: ApiService, private standardDelayTime: number) {}

  async fetchPairings(): Promise<void> {
    this.pairingsFetched = false
    const pairings: IPairing[] = await this.apiService.fetchData(API_ENDPOINTS.PAIRINGS)
    console.log('Pairings fetched:', Array.isArray(pairings) ? pairings.length : pairings)

    if (!Array.isArray(pairings)) {
      throw new Error('Pairings API returned a non-array response; refusing to start scheduler')
    }

    if (pairings.length === 0) {
      throw new Error('Pairings API returned zero pairings; refusing to start empty scheduler')
    }

    pairings.forEach((pairing: IPairing) => {
      this.addPairing(pairing, {
        measurementTime: DEFAULT_TIMING.SENSOR_READING_TIME,
        startDelayTime: this.standardDelayTime,
        delayTime: DEFAULT_TIMING.PROCESSING_DELAY,
        valveOpenTime: pairing.ValveOpenTime,
        intervalTime: pairing.MeasurementInterval,
      }, pairing.WTCPercentLimit)
    })

    this.pairingsFetched = true
  }

  /**
   * Clear all in-memory pairings and reset fetched flag.
   * Use when performing a full reload (e.g., on StateMachine restart)
   * to avoid retaining stale pairings that no longer exist in the API.
   */
  clearPairings(): void {
    if (this.pairings.size > 0) {
      console.log(`Clearing ${this.pairings.size} existing pairings before reload`)
    } else {
      console.log('No existing pairings to clear')
    }
    this.pairings.clear()
    this.pairingsFetched = false
  }

  addPairing(pairing: IPairing, timingRules: TimingSet, WTCPercentLimit: number = 0): void {
    const pairingId = `${pairing.sensorId}-${pairing.valveId}`
    const state: PairingState = {
      ...pairing,
      WTCPercentLimit: WTCPercentLimit,
      timingRules,
      state: 'STARTUP',
      WTCPercentMeasured: null,
      lastMeasurementAt: null,
      previousWTCPercentMeasured: null,
      previousMeasurementAt: null,
      measurementValid: false,
      wateringMeasurementValid: false,
      valveOpened: false,
      lastValveOpenedAt: null,
      wateringWindowStartedAt: null,
      wateringWindowPulseCount: 0,
      nextTransitionTime: null,
    }

    this.pairings.set(pairingId, state)
  }

  getPairing(sensorId: string, valveId: string): PairingState | undefined {
    const pairingId = `${sensorId}-${valveId}`
    return this.pairings.get(pairingId)
  }

  getAllPairings(): PairingState[] {
    return Array.from(this.pairings.values())
  }

  getPairingById(pairingId: string): PairingState | undefined {
    return this.pairings.get(pairingId)
  }

  setPairingState(sensorId: string, valveId: string, newState: PairingState['state']): void {
    const pairing = this.getPairing(sensorId, valveId)
    if (pairing) {
      pairing.state = newState
    }
  }

  isPairingsFetched(): boolean {
    return this.pairingsFetched
  }

  getMap(): Map<string, PairingState> {
    return this.pairings
  }
}

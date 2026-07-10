import { PairingState, PairingStateType } from '../types/system'

/**
 * Event queue item for state transitions
 */
export interface StateTransitionEvent {
  pairing: PairingState
  newState: PairingStateType
}

/**
 * Service responsible for managing the event queue and processing state transitions
 */
export class EventQueueService {
  private eventQueue: StateTransitionEvent[] = []
  private running: boolean = false
  private loadingPairings: boolean = false

  queueStateTransition(pairing: PairingState, newState: PairingStateType): void {
    this.eventQueue.push({ pairing, newState })

    // Only auto-start the event loop if not loading pairings
    if (!this.running && !this.loadingPairings) {
      this.processQueue()
    }
  }

  setLoadingPairings(loading: boolean): void {
    this.loadingPairings = loading
  }

  isRunning(): boolean {
    return this.running
  }

  processQueue(): void {
    if (this.running) return
    this.running = true

    const processNext = async () => {
      if (this.eventQueue.length === 0) {
        this.running = false
        return
      }

      const event = this.eventQueue.shift()!
      // Process the event - this will be handled by the callback
      // that's passed to this service
      await this.processEvent(event)

      setImmediate(processNext)
    }

    processNext()
  }

  stop(): void {
    this.eventQueue = []
    this.running = false
  }

  // This will be overridden by the StateMachine to provide actual processing logic
  private processEvent: (event: StateTransitionEvent) => Promise<void> = async () => {}

  setEventProcessor(processor: (event: StateTransitionEvent) => Promise<void>): void {
    this.processEvent = processor
  }

  getQueueLength(): number {
    return this.eventQueue.length
  }
}

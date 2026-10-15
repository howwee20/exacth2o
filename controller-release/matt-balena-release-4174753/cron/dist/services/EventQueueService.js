"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventQueueService = void 0;
/**
 * Service responsible for managing the event queue and processing state transitions
 */
class EventQueueService {
    constructor() {
        this.eventQueue = [];
        this.running = false;
        this.loadingPairings = false;
        // This will be overridden by the StateMachine to provide actual processing logic
        this.processEvent = async () => { };
    }
    queueStateTransition(pairing, newState) {
        this.eventQueue.push({ pairing, newState });
        // Only auto-start the event loop if not loading pairings
        if (!this.running && !this.loadingPairings) {
            this.processQueue();
        }
    }
    setLoadingPairings(loading) {
        this.loadingPairings = loading;
    }
    isRunning() {
        return this.running;
    }
    processQueue() {
        if (this.running)
            return;
        this.running = true;
        const processNext = async () => {
            if (this.eventQueue.length === 0) {
                this.running = false;
                return;
            }
            const event = this.eventQueue.shift();
            // Process the event - this will be handled by the callback
            // that's passed to this service
            await this.processEvent(event);
            setImmediate(processNext);
        };
        processNext();
    }
    stop() {
        this.eventQueue = [];
        this.running = false;
    }
    setEventProcessor(processor) {
        this.processEvent = processor;
    }
    getQueueLength() {
        return this.eventQueue.length;
    }
}
exports.EventQueueService = EventQueueService;

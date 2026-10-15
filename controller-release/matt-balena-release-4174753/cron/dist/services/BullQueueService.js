"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BullQueueService = void 0;
const bull_1 = __importDefault(require("bull"));
const constants_1 = require("../config/constants");
class BullQueueService {
    constructor(redisConfig) {
        this.loadingPairings = false;
        const defaultConfig = {
            host: constants_1.DEFAULT_REDIS_CONFIG.HOST,
            port: constants_1.DEFAULT_REDIS_CONFIG.PORT,
            password: constants_1.DEFAULT_REDIS_CONFIG.PASSWORD,
            db: constants_1.DEFAULT_REDIS_CONFIG.DB,
        };
        const config = redisConfig || defaultConfig;
        console.log(`Connecting to Redis at ${config.host}:${config.port}${config.db ? ` (db: ${config.db})` : ''}`);
        this.queue = new bull_1.default('state-transitions', {
            redis: config,
        });
        this.setupQueueProcessor();
    }
    setupQueueProcessor() {
        // Process jobs one at a time to prevent race conditions
        this.queue.process(1, async (job) => {
            const { pairing, newState } = job.data;
            const pairId = `${pairing.sensorId}-${pairing.valveId}`;
            const now = Date.now();
            const scheduledTime = job.opts.delay ? job.timestamp + job.opts.delay : job.timestamp;
            const actualDelay = now - scheduledTime;
            console.log(`🔄 [QUEUE] Processing job ${job.id}: ${pairId} -> ${newState}`);
            console.log(`📊 [TIMING] Job created: ${new Date(job.timestamp).toISOString()}`);
            console.log(`📊 [TIMING] Scheduled for: ${new Date(scheduledTime).toISOString()}`);
            console.log(`📊 [TIMING] Processing now: ${new Date(now).toISOString()}`);
            console.log(`📊 [TIMING] Actual delay from schedule: ${actualDelay}ms`);
            // Log pairing timing rules
            console.log(`⏱️  [RULES] Timing rules for ${pairId}:`);
            console.log(`   - Measurement time: ${pairing.timingRules.measurementTime}ms`);
            console.log(`   - Delay time: ${pairing.timingRules.delayTime}ms`);
            console.log(`   - Valve open time: ${pairing.timingRules.valveOpenTime}ms`);
            console.log(`   - Interval time: ${pairing.timingRules.intervalTime}ms`);
            if (pairing.nextTransitionTime) {
                const timeUntilNext = pairing.nextTransitionTime - now;
                console.log(`⏭️  [NEXT] Next transition scheduled for: ${new Date(pairing.nextTransitionTime).toISOString()}`);
                console.log(`⏭️  [NEXT] Time until next transition: ${timeUntilNext}ms`);
            }
            const processingStart = Date.now();
            if (this.eventProcessor) {
                await this.eventProcessor({ pairing, newState });
            }
            const processingTime = Date.now() - processingStart;
            console.log(`✅ [QUEUE] Job ${job.id} processing completed in ${processingTime}ms`);
        });
        this.queue.on('completed', (job) => {
            const { pairing, newState } = job.data;
            const pairId = `${pairing.sensorId}-${pairing.valveId}`;
            const totalTime = Date.now() - job.timestamp;
            console.log(`✅ [QUEUE] Job ${job.id} completed successfully`);
            console.log(`📊 [TIMING] Total job lifetime: ${totalTime}ms for ${pairId} -> ${newState}`);
        });
        this.queue.on('failed', (job, err) => {
            const { pairing, newState } = job.data;
            const pairId = `${pairing.sensorId}-${pairing.valveId}`;
            console.error(`❌ [QUEUE] Job ${job.id} failed for ${pairId} -> ${newState}:`, err);
        });
        this.queue.on('stalled', (job) => {
            const { pairing, newState } = job.data;
            const pairId = `${pairing.sensorId}-${pairing.valveId}`;
            console.warn(`⚠️  [QUEUE] Job ${job.id} stalled for ${pairId} -> ${newState} and will be retried`);
        });
        this.queue.on('waiting', (jobId) => {
            console.log(`⏳ [QUEUE] Job ${jobId} is waiting to be processed`);
        });
        this.queue.on('active', (job) => {
            const { pairing, newState } = job.data;
            const pairId = `${pairing.sensorId}-${pairing.valveId}`;
            console.log(`🚀 [QUEUE] Job ${job.id} became active: ${pairId} -> ${newState}`);
        });
    }
    async queueStateTransition(pairing, newState) {
        const pairId = `${pairing.sensorId}-${pairing.valveId}`;
        const now = Date.now();
        const nextTransitionTime = pairing.nextTransitionTime || now;
        // Remove any existing jobs for this pairing to prevent out-of-order execution
        console.log(`🧹 [QUEUE] Removing existing jobs for ${pairId} to prevent conflicts...`);
        const waitingJobs = await this.queue.getWaiting();
        const delayedJobs = await this.queue.getDelayed();
        const jobsToRemove = [...waitingJobs, ...delayedJobs].filter(job => {
            const jobPairId = `${job.data.pairing.sensorId}-${job.data.pairing.valveId}`;
            return jobPairId === pairId;
        });
        for (const job of jobsToRemove) {
            await job.remove();
            console.log(`🗑️  [QUEUE] Removed existing job ${job.id} for ${pairId}`);
        }
        // Calculate delay based on nextTransitionTime
        const delay = Math.max(0, nextTransitionTime - now);
        const finalDelay = this.loadingPairings ? Math.max(1000, delay) : delay;
        const scheduledExecutionTime = now + finalDelay;
        console.log(`📝 [QUEUE] Queueing state transition for ${pairId}`);
        console.log(`   Current state: ${pairing.state} -> New state: ${newState}`);
        console.log(`   Current time: ${new Date(now).toISOString()}`);
        console.log(`   Next transition time: ${new Date(nextTransitionTime).toISOString()}`);
        console.log(`   Calculated delay: ${delay}ms`);
        console.log(`   Final delay (with loading check): ${finalDelay}ms`);
        console.log(`   Scheduled execution: ${new Date(scheduledExecutionTime).toISOString()}`);
        console.log(`   Loading pairings: ${this.loadingPairings}`);
        // Log which timing rule is being applied
        const timingContext = this.getTimingContext(pairing.state, newState, pairing.timingRules);
        if (timingContext) {
            console.log(`⏱️  [CONTEXT] ${timingContext}`);
        }
        const jobId = `${pairId}-${newState}-${nextTransitionTime}`;
        const jobOptions = {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 2000,
            },
            delay: finalDelay,
            jobId,
            removeOnComplete: 10,
            removeOnFail: 5,
        };
        console.log(`🎯 [QUEUE] Adding job with ID: ${jobId}`);
        try {
            const job = await this.queue.add({ pairing, newState }, jobOptions);
            console.log(`✅ [QUEUE] Job ${job.id} successfully queued for ${pairId} -> ${newState}`);
        }
        catch (error) {
            console.error(`❌ [QUEUE] Failed to queue job for ${pairId} -> ${newState}:`, error);
        }
    }
    getTimingContext(currentState, newState, timingRules) {
        const stateTransitions = {
            'STARTUP->MEASURING': `Using start delay time: ${timingRules.startDelayTime}ms`,
            'IDLE->MEASURING': `Using measurement time: ${timingRules.measurementTime}ms`,
            'MEASURING->DELAY': `Using delay time: ${timingRules.delayTime}ms`,
            'DELAY->VALVE_OPEN': `Using valve open time: ${timingRules.valveOpenTime}ms`,
            'DELAY->IDLE': `No valve action; using interval time: ${timingRules.intervalTime}ms`,
            'DELAY->SENSOR_FAULT': `Fail-closed sensor fault; using interval time: ${timingRules.intervalTime}ms`,
            'VALVE_OPEN->VALVE_CLOSE': `Valve closing (immediate)`,
            'VALVE_CLOSE->IDLE': `Using interval time: ${timingRules.intervalTime}ms`,
            'IDLE->IDLE': `Restarting cycle with interval time: ${timingRules.intervalTime}ms`,
            'SENSOR_FAULT->MEASURING': `Retrying measurement after sensor fault interval: ${timingRules.intervalTime}ms`,
        };
        const key = `${currentState}->${newState}`;
        return stateTransitions[key] || `Unknown transition: ${key}`;
    }
    setLoadingPairings(loading) {
        this.loadingPairings = loading;
    }
    isRunning() {
        return this.queue.name !== undefined;
    }
    async processQueue() {
        await this.queue.resume();
        await this.queue.resume(true);
    }
    async clearQueue() {
        console.log('🧹 [QUEUE] Emptying queue...');
        await this.queue.empty();
        console.log('🧹 [QUEUE] Queue Emptied.');
        console.log('🧹 [QUEUE] Clearing stuck jobs as part of queue clear...');
        await this.clearStuckJobs();
        console.log('🧹 [QUEUE] Stuck jobs cleared.');
    }
    async stop() {
        console.log('🛑 [QUEUE] Stopping queue - pausing and clearing all jobs...');
        await this.queue.pause();
        // A global pause prevents new jobs but leaves the current worker running.
        // Wait for that worker before clearing: Bull cannot remove a locked job,
        // and an unfinished transition could otherwise enqueue work after STOPPED.
        await this.queue.pause(true);
        // No worker should remain after the local pause has drained it. Do not
        // delete active jobs: a lock means their outcome is still unconfirmed.
        const activeJobs = await this.queue.getActive();
        if (activeJobs.length > 0) {
            throw new Error('Cannot stop queue while an active job remains');
        }
        // Clear follow-up transitions only after the current job has finished.
        await this.clearQueue();
        // Clean delayed jobs too
        const delayedJobs = await this.queue.getDelayed();
        console.log(`🛑 [QUEUE] Cancelling ${delayedJobs.length} delayed jobs...`);
        for (const job of delayedJobs) {
            await job.remove();
        }
        // // Finally, obliterate to ensure everything is cleared
        // console.log('🛑 [QUEUE] Obliterating all jobs to be sure the queue is empty...')
        // await this.queue.obliterate({ force: true });
        console.log('✅ [QUEUE] Queue fully stopped and cleared');
    }
    setEventProcessor(processor) {
        this.eventProcessor = processor;
    }
    async getQueueLength() {
        const waiting = await this.queue.getWaiting();
        const active = await this.queue.getActive();
        return waiting.length + active.length;
    }
    async close() {
        await this.queue.close();
    }
    /**
     * Cleans up "stuck" jobs from the queue based on age and status criteria.
     *
     * A job is considered "stuck" when:
     * - COMPLETED jobs: Older than 30 seconds (housekeeping)
     * - FAILED jobs: Older than 30 seconds (housekeeping)
     * - ACTIVE jobs: Older than 60 seconds (likely stalled/crashed)
     * - DELAYED jobs: Past their scheduled execution time (overdue)
     *
     * Cleanup Criteria:
     * - Completed/Failed: Remove old results to prevent memory bloat
     * - Active: Remove jobs that have been processing too long (likely stuck)
     * - Delayed: Remove jobs that should have executed but didn't
     *
     * Note: Bull's clean() method uses Redis-based filtering for efficiency
     * and doesn't require fetching all jobs into memory.
     */
    async clearStuckJobs() {
        console.log('🧹 [CLEANUP] Starting stuck job cleanup...');
        // Clean completed jobs older than 30 seconds (housekeeping)
        const cleanedCompleted = await this.queue.clean(30000, 'completed');
        // Clean failed jobs older than 30 seconds (housekeeping)
        const cleanedFailed = await this.queue.clean(30000, 'failed');
        // Clean active jobs older than 60 seconds (likely stalled)
        const cleanedActive = await this.queue.clean(60000, 'active');
        // Clean delayed jobs that are overdue (past their execution time)
        const cleanedDelayed = await this.queue.clean(0, 'delayed');
        console.log(`🧹 [CLEANUP] Cleaned jobs: ${cleanedCompleted.length} completed, ${cleanedFailed.length} failed, ${cleanedActive.length} active, ${cleanedDelayed.length} delayed`);
        if (cleanedActive.length > 0) {
            console.warn(`⚠️  [CLEANUP] Removed ${cleanedActive.length} stuck active jobs - check for processing issues`);
        }
    }
    async getQueueStats() {
        // Get basic counts efficiently using Bull's built-in methods
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            this.queue.getWaiting(),
            this.queue.getActive(),
            this.queue.getCompleted(),
            this.queue.getFailed(),
            this.queue.getDelayed()
        ]);
        // For large queues, limit detailed analysis to first 20 waiting jobs
        const waitingToAnalyze = waiting.slice(0, 20);
        const now = Date.now();
        const waitingJobDetails = waitingToAnalyze.map(job => {
            const scheduledTime = job.opts.delay ? job.timestamp + job.opts.delay : job.timestamp;
            const timeUntilExecution = scheduledTime - now;
            const { pairing, newState } = job.data;
            return {
                jobId: job.id,
                pairId: `${pairing.sensorId}-${pairing.valveId}`,
                state: `${pairing.state} -> ${newState}`,
                scheduledFor: new Date(scheduledTime).toISOString(),
                timeUntilExecution: timeUntilExecution,
                isOverdue: timeUntilExecution < 0
            };
        });
        const overdueJobs = waitingJobDetails.filter(job => job.isOverdue);
        const upcomingJobs = waitingJobDetails.filter(job => !job.isOverdue);
        return {
            waiting: waiting.length,
            active: active.length,
            completed: completed.length,
            failed: failed.length,
            delayed: delayed.length,
            total: waiting.length + active.length,
            overdueJobs: overdueJobs.length,
            upcomingJobs: upcomingJobs.length,
            analyzedJobs: waitingJobDetails.length, // Show how many we actually analyzed
            summary: {
                overdue: overdueJobs,
                nextUpcoming: upcomingJobs.slice(0, 5)
            }
        };
    }
    async logQueueSummary() {
        const stats = await this.getQueueStats();
        console.log(`\n📊 [QUEUE SUMMARY] Queue Statistics:`);
        console.log(`   Total jobs: ${stats.total} (${stats.waiting} waiting, ${stats.active} active, ${stats.delayed} delayed)`);
        console.log(`   Completed: ${stats.completed}, Failed: ${stats.failed}`);
        console.log(`   Analyzed: ${stats.analyzedJobs} of ${stats.waiting} waiting jobs (for performance)`);
        console.log(`   Overdue jobs: ${stats.overdueJobs}`);
        if (stats.summary.overdue.length > 0) {
            console.log(`\n⚠️  [OVERDUE] Jobs that should have executed:`);
            stats.summary.overdue.forEach((job) => {
                console.log(`   - ${job.pairId}: ${job.state} (${Math.abs(job.timeUntilExecution)}ms overdue)`);
            });
        }
        if (stats.summary.nextUpcoming.length > 0) {
            console.log(`\n⏰ [UPCOMING] Next jobs to execute:`);
            stats.summary.nextUpcoming.forEach((job) => {
                console.log(`   - ${job.pairId}: ${job.state} in ${job.timeUntilExecution}ms (${job.scheduledFor})`);
            });
        }
        console.log(`\n`);
    }
    getQueue() {
        return this.queue;
    }
}
exports.BullQueueService = BullQueueService;

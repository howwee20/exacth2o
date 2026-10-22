import { BullQueueService } from '../services/BullQueueService'
import { PairingState } from '../types'

// Opt in only against a disposable, loopback Redis instance. No controller or
// hardware is used. Example: VALVE_QUEUE_TEST_REDIS_PORT=56379 npm test -- ValveQueueRedis
const port = Number(process.env.VALVE_QUEUE_TEST_REDIS_PORT)
const redisDescribe = port > 0 ? describe : describe.skip

redisDescribe('FIFO wake-up with real Bull and Redis', () => {
  let service: BullQueueService
  const create = () => new BullQueueService({ host: '127.0.0.1', port, db: 15 })
  const pairing = (id: number, delay = 60000) => ({
    sensorId: id, valveId: id, state: 'DELAY', nextTransitionTime: Date.now() + delay,
    timingRules: { measurementTime: 1000, delayTime: 0, valveOpenTime: 3000, intervalTime: 600000 },
  } as PairingState)
  async function until(check: () => boolean) {
    const deadline = Date.now() + 3000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Queue did not progress')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  beforeEach(async () => {
    service = create()
    await service.getQueue().isReady()
    await service.getQueue().pause(true)
    await service.getQueue().obliterate({ force: true })
  })
  afterEach(async () => {
    await service.getQueue().pause(true)
    await service.getQueue().obliterate({ force: true })
    await service.close()
  })

  it('reconstructs FIFO after worker recreation and promotes one head without duplicates', async () => {
    const b = pairing(1, 60000), c = pairing(2, 30000)
    await service.registerValveWaiter(b)
    await service.registerValveWaiter(c)
    await service.queueStateTransition(b, 'DELAY')
    await service.queueStateTransition(c, 'DELAY')
    await service.queueStateTransition(b, 'DELAY')
    expect(await service.getQueue().getDelayedCount()).toBe(2)
    await service.close()
    service = create()
    await service.getQueue().pause(true)
    const processed: number[] = []
    service.setEventProcessor(async ({ pairing: p }) => {
      expect(p.nextTransitionTime).toBeLessThanOrEqual(Date.now())
      expect(await service.hasEarlierValveWaiter(p)).toBe(false)
      processed.push(p.sensorId)
    })
    // A fresh request cannot jump in front of B after recreating the worker.
    const d = pairing(3)
    await service.registerValveWaiter(d)
    expect(d.valveWaitOrder).toBeGreaterThan(c.valveWaitOrder!)
    expect(await service.hasEarlierValveWaiter(d)).toBe(true)
    await service.wakeNextValveWaiter()
    await service.wakeNextValveWaiter()
    expect(await service.getQueue().getDelayedCount()).toBe(1)
    await service.processQueue()
    await until(() => processed.length === 1)
    expect(processed).toEqual([1])
    await service.wakeNextValveWaiter()
    await until(() => processed.length === 2)
    expect(processed).toEqual([1, 2])
  })

  it('still runs the timed fallback when no wake notification arrives', async () => {
    const b = pairing(1, 150)
    await service.registerValveWaiter(b)
    await service.queueStateTransition(b, 'DELAY')
    let processed = false
    service.setEventProcessor(async () => { processed = true })
    await service.processQueue()
    await until(() => processed)
    expect(processed).toBe(true)
  })
})

import { BullQueueService } from '../services/BullQueueService'

describe('stopping the controller queue', () => {
  it('waits for the running transition before clearing its queued follow-up', async () => {
    const service = Object.create(BullQueueService.prototype) as any
    let finish!: () => void
    const active = new Promise<void>(resolve => { finish = resolve })
    const remove = jest.fn().mockRejectedValue(new Error('Could not remove locked job'))
    let running = true
    service.queue = {
      pause: jest.fn(async (local?: boolean) => {
        if (local) { await active; running = false }
      }),
      getActive: jest.fn(async () => running ? [{ remove }] : []),
      getDelayed: jest.fn().mockResolvedValue([]),
    }
    service.clearQueue = jest.fn().mockResolvedValue(undefined)

    const stopped = service.stop()
    await Promise.resolve()
    expect(service.clearQueue).not.toHaveBeenCalled()
    finish()
    await stopped

    expect(service.queue.pause.mock.calls).toEqual([[], [true]])
    expect(service.clearQueue).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
  })

  it('keeps a remaining active job intact and fails the stop', async () => {
    const service = Object.create(BullQueueService.prototype) as any
    const remove = jest.fn()
    service.queue = {
      pause: jest.fn().mockResolvedValue(undefined),
      getActive: jest.fn().mockResolvedValue([{ remove }]),
    }
    service.clearQueue = jest.fn().mockResolvedValue(undefined)
    await expect(service.stop()).rejects.toThrow('active job remains')
    expect(remove).not.toHaveBeenCalled()
    expect(service.clearQueue).not.toHaveBeenCalled()
  })

  it('resumes both the shared queue and the drained local worker', async () => {
    const service = Object.create(BullQueueService.prototype) as any
    service.queue = { resume: jest.fn().mockResolvedValue(undefined) }
    await service.processQueue()
    expect(service.queue.resume.mock.calls).toEqual([[], [true]])
  })
})

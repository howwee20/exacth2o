import { HoldCallbacks, HoldError, HoldSession, HoldSignal, ManualHoldManager } from '../services/ManualHoldManager'

// Every test drives a virtual clock: wall and monotonic time advance together, except
// where a test deliberately skews or steps the wall clock.
describe('controller-owned manual hold (renewable lease)', () => {
  let storage: Map<string, string>
  let wall: number
  let mono: number
  let relay: Array<{ op: 'open' | 'close'; session: string; at: number }>
  let owner: string | null
  let callbacks: HoldCallbacks & { acquire: jest.Mock; open: jest.Mock; close: jest.Mock; release: jest.Mock }
  let managers: ManualHoldManager[]

  const advance = async (ms: number) => {
    // Step in small increments so timers fire at the right virtual moment.
    const step = 50
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      const slice = Math.min(step, ms - elapsed)
      wall += slice
      mono += slice
      jest.advanceTimersByTime(slice)
      await Promise.resolve()
    }
    await flushPromises()
  }
  const flushPromises = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

  const signal = (overrides: Partial<HoldSignal> = {}): HoldSignal => ({
    sessionId: '01234567-89ab-cdef-0123-456789abcdef',
    ownerId: 'operator-a',
    sequence: 0,
    expiresAt: wall + 2_000,
    route: { relayAddress: 0x20, address: 26, kind: 'solenoid' },
    ...overrides,
  })

  const create = (options: ConstructorParameters<typeof ManualHoldManager>[2] = {}, file = 'holds.json') => {
    const manager = new ManualHoldManager(file, callbacks, {
      now: () => wall, mono: () => mono, leaseMs: 2_500, closeRetryMs: 200,
      write: async (name, body) => { storage.set(name, body) },
      read: async (name) => storage.get(name) ?? null,
      ...options,
    })
    managers.push(manager)
    return manager
  }

  beforeEach(async () => {
    jest.useFakeTimers()
    storage = new Map()
    wall = Date.parse('2026-10-21T15:00:00Z')
    mono = 1_000_000
    relay = []
    owner = null
    managers = []
    callbacks = {
      acquire: jest.fn(async (session: HoldSession) => {
        if (owner && owner !== session.sessionId) throw new HoldError('Another manual hold owns the output', 'busy')
        owner = session.sessionId
      }),
      open: jest.fn((session: HoldSession) => { relay.push({ op: 'open', session: session.sessionId, at: mono }) }),
      close: jest.fn((session: HoldSession) => { relay.push({ op: 'close', session: session.sessionId, at: mono }) }),
      release: jest.fn((session: HoldSession) => { if (owner === session.sessionId) owner = null }),
    }
  })

  afterEach(async () => {
    for (const manager of managers) {
      await manager.stopAll().catch(() => undefined)
      await manager.flush().catch(() => undefined)
    }
    jest.useRealTimers()
  })

  const holdFor = async (manager: ManualHoldManager, ms: number, every = 400, base = signal()) => {
    let sequence = base.sequence
    for (let elapsed = 0; elapsed < ms; elapsed += every) {
      await advance(every)
      sequence += 1
      await manager.request('renew', { ...base, sequence, expiresAt: wall + 2_000 })
    }
    return sequence
  }

  test('a continuous hold stays open far beyond 15 seconds with one open and no relay chatter', async () => {
    const manager = create()
    await manager.recover()
    const start = await manager.request('start', signal())
    expect(start.status).toBe('open')
    const sequence = await holdFor(manager, 90_000)
    const status = await manager.request('status', signal())
    expect(status.status).toBe('open')
    expect(status.openedForMs).toBeGreaterThanOrEqual(90_000)
    expect(relay).toEqual([{ op: 'open', session: signal().sessionId, at: expect.any(Number) }])
    await manager.request('stop', signal({ sequence: sequence + 1 }))
    expect(relay.map((entry) => entry.op)).toEqual(['open', 'close'])
  })

  test('the lease ends the hold on the controller when renewals stop, and it never reopens', async () => {
    const manager = create()
    await manager.recover()
    await manager.request('start', signal())
    await holdFor(manager, 3_000)
    const lastRenewalAt = mono
    await advance(5_000)
    const closes = relay.filter((entry) => entry.op === 'close')
    expect(closes).toHaveLength(1)
    // Closed within the lease (2.5 s) of the last accepted renewal, not later.
    expect(closes[0].at - lastRenewalAt).toBeLessThanOrEqual(2_000 + 50)
    const late = await manager.request('renew', signal({ sequence: 99, expiresAt: wall + 2_000 }))
    expect(late.status).toBe('closed')
    expect(late.endReason).toBe('expired')
    const again = await manager.request('start', signal({ sequence: 100, expiresAt: wall + 2_000 }))
    expect(again.status).toBe('closed')
    expect(callbacks.open).toHaveBeenCalledTimes(1)
  })

  test('a long session is still remembered after it ends, beyond the old start-time retention', async () => {
    const manager = create({ tombstoneMs: 10 * 60_000 })
    await manager.recover()
    await manager.request('start', signal())
    // 12 minutes of holding: longer than the retention window itself.
    const sequence = await holdFor(manager, 12 * 60_000, 1_000)
    await manager.request('stop', signal({ sequence: sequence + 1 }))
    await advance(60_000)
    // A delayed duplicate start for the same session arrives a minute after release.
    const replay = await manager.request('start', signal({ sequence: 1, expiresAt: wall + 2_000 }))
    expect(replay.status).toBe('closed')
    expect(replay.endReason).toBe('released')
    expect(callbacks.open).toHaveBeenCalledTimes(1)
    await manager.flush()
    const persisted = JSON.parse(storage.get('holds.json')!)
    expect(persisted.tombstones.map((t: any) => t.sessionId)).toContain(signal().sessionId)
  })

  test('a stop delivered before its start prevents that start from ever opening the valve', async () => {
    const manager = create()
    await manager.recover()
    expect((await manager.request('stop', signal({ sequence: 1 }))).status).toBe('closed')
    const start = await manager.request('start', signal({ sequence: 0 }))
    expect(start.status).toBe('closed')
    expect(start.endReason).toBe('stopped_before_start')
    expect(callbacks.acquire).not.toHaveBeenCalled()
    expect(callbacks.open).not.toHaveBeenCalled()
  })

  test('releasing while the controller is still taking manual control never opens the valve', async () => {
    let finishAcquire: () => void = () => undefined
    callbacks.acquire.mockImplementationOnce(async (session: HoldSession) => {
      owner = session.sessionId
      await new Promise<void>((resolve) => { finishAcquire = resolve })
    })
    const manager = create()
    await manager.recover()
    const pendingStart = manager.request('start', signal())
    await flushPromises()
    const stopped = await manager.request('stop', signal({ sequence: 1 }))
    expect(stopped.status).toBe('closed')
    finishAcquire()
    const start = await pendingStart
    expect(start.status).toBe('closed')
    expect(callbacks.open).not.toHaveBeenCalled()
    expect(callbacks.release).toHaveBeenCalledTimes(1)
    expect(owner).toBeNull()
  })

  test('a stop that lands while the relay open is in flight closes the valve once the open returns', async () => {
    let finishOpen: () => void = () => undefined
    callbacks.open.mockImplementationOnce((session: HoldSession) => new Promise<void>((resolve) => {
      finishOpen = () => { relay.push({ op: 'open', session: session.sessionId, at: mono }); resolve() }
    }))
    const manager = create()
    await manager.recover()
    const pendingStart = manager.request('start', signal())
    for (let i = 0; i < 100 && callbacks.open.mock.calls.length === 0; i++) await Promise.resolve()
    expect(callbacks.open).toHaveBeenCalledTimes(1)
    await manager.request('stop', signal({ sequence: 1 }))
    expect(relay).toEqual([])
    finishOpen()
    await pendingStart
    expect(relay.map((entry) => entry.op)).toEqual(['open', 'close'])
    expect(owner).toBeNull()
  })

  test('duplicate starts never actuate twice, and a renewal cannot create a session', async () => {
    const manager = create()
    await manager.recover()
    expect((await manager.request('renew', signal({ sequence: 3 }))).status).toBe('closed')
    expect(callbacks.open).not.toHaveBeenCalled()
    await manager.request('start', signal())
    await manager.request('start', signal({ sequence: 1 }))
    await manager.request('start', signal({ sequence: 2 }))
    expect(callbacks.open).toHaveBeenCalledTimes(1)
    expect(callbacks.acquire).toHaveBeenCalledTimes(1)
  })

  test('a renewal cannot change the output, and another operator cannot renew or stop the hold', async () => {
    const manager = create()
    await manager.recover()
    await manager.request('start', signal())
    await expect(manager.request('renew', signal({ sequence: 1, route: { relayAddress: 0x20, address: 27, kind: 'solenoid' } }))).rejects.toThrow('route changed')
    await expect(manager.request('renew', signal({ sequence: 2, ownerId: 'operator-b' }))).rejects.toThrow('owner')
    await expect(manager.request('stop', signal({ sequence: 3, ownerId: 'operator-b' }))).rejects.toThrow('owner')
    expect((await manager.request('status', signal())).status).toBe('open')
    expect(callbacks.close).not.toHaveBeenCalled()
  })

  test('a delayed stop from an old session cannot close a newer session', async () => {
    const manager = create()
    await manager.recover()
    const first = signal({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
    await manager.request('start', first)
    await manager.request('stop', { ...first, sequence: 1 })
    const second = signal({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000002', expiresAt: wall + 2_000 })
    await manager.request('start', second)
    // The first session's stop is delivered again, late.
    await manager.request('stop', { ...first, sequence: 2 })
    expect((await manager.request('status', second)).status).toBe('open')
    expect(relay.filter((entry) => entry.session === second.sessionId).map((entry) => entry.op)).toEqual(['open'])
  })

  test('late signals cannot start or extend, and a skewed sender clock cannot stretch the lease', async () => {
    const manager = create()
    await manager.recover()
    await expect(manager.request('start', signal({ expiresAt: wall - 1 }))).rejects.toThrow('expired')
    expect(callbacks.open).not.toHaveBeenCalled()
    // A sender whose clock runs 60 s fast asks for an expiry a minute away.
    await manager.request('start', signal({ expiresAt: wall + 60_000 }))
    expect((await manager.request('status', signal())).remainingMs).toBeLessThanOrEqual(2_500)
    await advance(2_600)
    expect(relay.map((entry) => entry.op)).toEqual(['open', 'close'])
  })

  test('a wall-clock step during a hold neither stretches nor cuts the monotonic lease', async () => {
    const manager = create()
    await manager.recover()
    await manager.request('start', signal())
    wall += 3_600_000 // NTP step forward one hour; monotonic time is unaffected
    await advance(1_000)
    expect((await manager.request('status', signal())).status).toBe('open')
    await advance(1_600)
    expect(relay.map((entry) => entry.op)).toEqual(['open', 'close'])
  })

  test('out-of-order renewals never shorten or reopen a hold', async () => {
    const manager = create()
    await manager.recover()
    await manager.request('start', signal())
    await manager.request('renew', signal({ sequence: 3, expiresAt: wall + 2_000 }))
    const late = await manager.request('renew', signal({ sequence: 2, expiresAt: wall + 200 }))
    expect(late.remainingMs).toBeGreaterThan(1_500)
    await manager.request('stop', signal({ sequence: 4 }))
    expect((await manager.request('renew', signal({ sequence: 5, expiresAt: wall + 2_000 }))).status).toBe('closed')
    expect(callbacks.open).toHaveBeenCalledTimes(1)
  })

  test('a second session is refused while one is active, and an explicit takeover closes the first before opening', async () => {
    const manager = create()
    await manager.recover()
    const first = signal({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000001', ownerId: 'operator-a' })
    const second = signal({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', ownerId: 'operator-b', route: { relayAddress: 0x24, address: 18, kind: 'pot' } })
    await manager.request('start', first)
    await expect(manager.request('start', second)).rejects.toThrow('Another manual hold')
    const busy = await manager.request('status', second)
    expect(busy).toMatchObject({ busy: true, activeOwnerId: 'operator-a' })
    const takeover = await manager.request('start', { ...second, takeover: true, expiresAt: wall + 2_000 })
    expect(takeover.status).toBe('open')
    expect(relay.map((entry) => `${entry.op}:${entry.session.slice(-1)}`)).toEqual(['open:1', 'close:1', 'open:2'])
    expect((await manager.request('status', first)).endReason).toBe('preempted')
  })

  test('a failed close keeps the output owned, retries until it closes, and holds stay disabled until reconciled', async () => {
    const manager = create()
    await manager.recover()
    await manager.request('start', signal())
    callbacks.close.mockImplementationOnce(() => { throw new Error('relay failed') }).mockImplementationOnce(() => { throw new Error('relay failed') })
    await expect(manager.request('stop', signal({ sequence: 1 }))).rejects.toThrow('relay failed')
    expect((await manager.request('status', signal())).status).toBe('fault')
    expect(owner).toBe(signal().sessionId)
    await expect(manager.request('start', signal({ sessionId: 'cccccccc-0000-4000-8000-000000000001', expiresAt: wall + 2_000 }))).rejects.toThrow('not confirmed')
    await advance(600)
    expect(callbacks.close).toHaveBeenCalledTimes(3)
    expect(owner).toBeNull()
    expect((await manager.request('status', signal())).ready).toBe(false)
    expect(manager.reconcileFault()).toBe(true)
    expect((await manager.request('start', signal({ sessionId: 'cccccccc-0000-4000-8000-000000000002', expiresAt: wall + 2_000 }))).status).toBe('open')
  })

  test('a restart closes a persisted open hold before accepting requests, including the old record format', async () => {
    const manager = create()
    await manager.recover()
    await manager.request('start', signal())
    await manager.flush()
    const recovered = create()
    await recovered.recover()
    expect(callbacks.close).toHaveBeenCalledTimes(1)
    expect((await recovered.request('start', signal({ sequence: 5, expiresAt: wall + 2_000 }))).endReason).toBe('recovered_after_restart')

    const legacyFile = 'legacy.json'
    storage.set(legacyFile, JSON.stringify({ active: { sessionId: 'dddddddd-0000-4000-8000-000000000001', ownerId: 'o', relayAddress: 36, address: 18, startedAt: wall }, records: [] }))
    const legacy = create({}, legacyFile)
    await legacy.recover()
    expect(callbacks.close).toHaveBeenLastCalledWith(expect.objectContaining({ route: expect.objectContaining({ relayAddress: 36, address: 18 }) }))
    expect(legacy.isReady()).toBe(true)
  })

  test('stop and expiry close the relay immediately even when storage is slow', async () => {
    const writes: Array<() => void> = []
    const slowWrite = () => new Promise<void>((resolve) => { writes.push(resolve) })
    const nextWrite = async () => {
      for (let i = 0; i < 100 && writes.length === 0; i++) await Promise.resolve()
      writes.shift()?.()
    }
    const manager = create({ write: slowWrite })
    const recovering = manager.recover()
    await nextWrite()
    await recovering
    const starting = manager.request('start', signal())
    await nextWrite() // the write-ahead record before opening
    await starting
    expect(relay.map((entry) => entry.op)).toEqual(['open'])
    // Storage now stalls for good: the stop must not wait for it.
    await manager.request('stop', signal({ sequence: 1 }))
    expect(relay.map((entry) => entry.op)).toEqual(['open', 'close'])
    for (let i = 0; i < 10; i++) { writes.splice(0).forEach((resolve) => resolve()); await flushPromises() }
  })

  test('a configured continuous-on hardware limit ends even an actively renewed hold', async () => {
    const manager = create({ maxContinuousMs: 30_000 })
    await manager.recover()
    await manager.request('start', signal())
    await holdFor(manager, 31_000)
    const status = await manager.request('status', signal())
    expect(status.status).toBe('closed')
    expect(status.endReason).toBe('continuous_limit')
    expect(status.maxContinuousMilliseconds).toBe(30_000)
  })

  test('without a configured hardware limit no maximum hold length is reported or applied', async () => {
    const manager = create()
    await manager.recover()
    const reply = await manager.request('start', signal())
    expect(reply.maxContinuousMilliseconds).toBeNull()
    expect(reply.leaseMilliseconds).toBe(2_500)
  })

  test('a failed relay open is closed through the normal path and reported, not left open', async () => {
    callbacks.open.mockImplementationOnce(() => { throw new Error('i2c write failed') })
    const manager = create()
    await manager.recover()
    await expect(manager.request('start', signal())).rejects.toThrow('did not open')
    expect(callbacks.close).toHaveBeenCalledTimes(1)
    expect(owner).toBeNull()
    expect((await manager.request('status', signal())).endReason).toBe('start_failed')
  })

  test('tombstones are bounded and the newest are kept', async () => {
    const manager = create({ maxTombstones: 50 })
    await manager.recover()
    for (let index = 0; index < 120; index += 1) {
      const id = `eeeeeeee-0000-4000-8000-${String(index).padStart(12, '0')}`
      await manager.request('stop', signal({ sessionId: id }))
      await advance(10)
    }
    await manager.flush()
    const persisted = JSON.parse(storage.get('holds.json')!)
    expect(persisted.tombstones).toHaveLength(50)
    expect(persisted.tombstones.map((t: any) => t.sessionId)).toContain('eeeeeeee-0000-4000-8000-000000000119')
  })
})

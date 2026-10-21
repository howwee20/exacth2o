import { ArbiterStatus, ValveWatchdog, WatchdogIO, WatchdogState } from '../watchdog/ValveWatchdog'

function harness(initial: WatchdogState | null = null) {
  let now = 0
  let next: ArbiterStatus | Error = { owner: null }
  const events: string[] = []
  const saved: WatchdogState[] = []
  const io: WatchdogIO = {
    mono: () => now,
    poll: async () => { if (next instanceof Error) throw next; return next },
    assertReset: () => { events.push('reset-low') },
    releaseReset: () => { events.push('reset-high') },
    notifyTrip: async () => { events.push('notify') },
    save: (state) => { saved.push({ ...state }) },
    log: () => undefined,
  }
  const watchdog = new ValveWatchdog(io, initial)
  return {
    watchdog, events, saved,
    set: (status: ArbiterStatus | Error) => { next = status },
    tickAt: async (ms: number) => { now = ms; await watchdog.tick() },
  }
}

const hold = (deadlineInMs: number, key = 'hold:session-1') => ({ owner: { key, kind: 'hold' as const, deadlineInMs }, arbiter: { fault: null } })

describe('independent valve watchdog', () => {
  it('stays quiet while cron answers and closes its own holds on time', async () => {
    const h = harness()
    for (let t = 0; t <= 60_000; t += 250) {
      h.set(hold(2_000))
      await h.tickAt(t)
    }
    h.set({ owner: null, arbiter: { fault: null } })
    await h.tickAt(60_250)
    expect(h.events).toEqual([])
    expect(h.watchdog.state.tripped).toBe(false)
  })

  it('forces every output off when cron stops answering with a hold open past its lease', async () => {
    const h = harness()
    h.set(hold(2_000))
    await h.tickAt(0)
    h.set(new Error('connect ECONNREFUSED'))
    await h.tickAt(2_000)
    await h.tickAt(3_400)
    expect(h.events).toEqual([])
    // Deadline 2.0 s + 1.5 s grace: trips on the first poll after 3.5 s.
    await h.tickAt(3_750)
    expect(h.events).toEqual(['reset-low'])
    expect(h.watchdog.state).toMatchObject({ tripped: true, acknowledged: false })
    expect(h.saved.at(-1)?.tripped).toBe(true)
  })

  it('trips when cron is alive but keeps reporting an output past its deadline', async () => {
    const h = harness()
    h.set(hold(0))
    await h.tickAt(0)
    await h.tickAt(1_000)
    expect(h.events).toEqual([])
    await h.tickAt(1_600)
    expect(h.events).toEqual(['reset-low'])
  })

  it('gives automatic pulses a wider grace so queue delays do not trip it', async () => {
    const h = harness()
    h.set({ owner: { key: '712-1625', kind: 'automatic', deadlineInMs: 3_000 }, arbiter: { fault: null } })
    await h.tickAt(0)
    h.set(new Error('timeout'))
    await h.tickAt(60_000)
    expect(h.events).toEqual([])
    await h.tickAt(123_100)
    expect(h.events).toEqual(['reset-low'])
  })

  it('holds the lockout, re-asserting it, until cron acknowledges and an operator reconciles', async () => {
    const h = harness()
    h.set(hold(500))
    await h.tickAt(0)
    h.set(new Error('stalled'))
    await h.tickAt(2_500)
    expect(h.watchdog.state.tripped).toBe(true)
    // cron restarts without knowledge of the trip: the watchdog re-asserts and notifies.
    h.set({ owner: null, arbiter: { fault: null } })
    await h.tickAt(2_750)
    expect(h.events.slice(-2)).toEqual(['reset-low', 'notify'])
    expect(h.watchdog.state.acknowledged).toBe(false)
    // cron records the trip as a fault.
    h.set({ owner: null, arbiter: { fault: { reason: 'valve watchdog: stalled', source: 'watchdog' } } })
    await h.tickAt(3_000)
    expect(h.watchdog.state.acknowledged).toBe(true)
    await h.tickAt(3_250)
    expect(h.events.at(-1)).toBe('reset-low')
    // Operator reconciles: fault cleared, nothing owns the output.
    h.set({ owner: null, arbiter: { fault: null } })
    await h.tickAt(3_500)
    expect(h.events.at(-1)).toBe('reset-high')
    expect(h.watchdog.state.tripped).toBe(false)
  })

  it('a watchdog restart keeps a persisted lockout asserted from the first moment', () => {
    const h = harness({ tripped: true, reason: 'earlier trip', trippedAtWall: '2026-10-21T15:00:00Z', acknowledged: true })
    expect(h.events).toEqual(['reset-low'])
  })
})

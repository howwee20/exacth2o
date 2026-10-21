import { readFileSync, renameSync, writeFileSync } from 'fs'
import { ValveWatchdog, WatchdogState } from './ValveWatchdog'
import { monotonicMs } from '../services/ValveArbiter'

// Entry point for the valve_watchdog service. See ValveWatchdog for the design.
const cronUrl = (process.env.VALVE_WATCHDOG_CRON_URL || 'http://cron_svc:3000/v1').replace(/\/+$/, '')
const secret = process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET || ''
const stateFile = process.env.VALVE_WATCHDOG_STATE_FILE || '/data/valve-watchdog.json'
const pollMs = Math.min(2_000, Math.max(100, Number(process.env.VALVE_WATCHDOG_POLL_MS || 250)))
const pins = String(process.env.VALVE_WATCHDOG_RESET_GPIOS || '16')
  .split(',')
  .map((pin) => Number(pin.trim()))
  .filter((pin) => Number.isInteger(pin) && pin >= 0 && pin <= 27)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpio = process.platform === 'linux' ? require('rpio') : require('../controllers/mocks/rpio')

function loadState(): WatchdogState | null {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}

const initial = loadState()
rpio.init({ mapping: 'gpio', gpiomem: true })
for (const pin of pins) rpio.open(pin, rpio.OUTPUT, initial?.tripped ? rpio.LOW : rpio.HIGH)

const watchdog = new ValveWatchdog({
  mono: monotonicMs,
  poll: async () => {
    const response = await fetch(`${cronUrl}/valves/arbiter`, { signal: AbortSignal.timeout(Math.max(200, pollMs * 1.6)) })
    if (!response.ok) throw new Error(`arbiter status ${response.status}`)
    return response.json()
  },
  assertReset: () => { for (const pin of pins) rpio.write(pin, rpio.LOW) },
  releaseReset: () => { for (const pin of pins) rpio.write(pin, rpio.HIGH) },
  notifyTrip: async (reason) => {
    await fetch(`${cronUrl}/valves/watchdog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-exacth2o-controller-secret': secret },
      body: JSON.stringify({ event: 'tripped', reason }),
      signal: AbortSignal.timeout(1_000),
    })
  },
  save: (state) => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 })
    renameSync(`${stateFile}.tmp`, stateFile)
  },
  log: (message) => console.log(message),
}, initial, {
  holdGraceMs: Number(process.env.VALVE_WATCHDOG_HOLD_GRACE_MS || 1_500),
  pulseGraceMs: Number(process.env.VALVE_WATCHDOG_PULSE_GRACE_MS || 5_000),
  automaticGraceMs: Number(process.env.VALVE_WATCHDOG_AUTOMATIC_GRACE_MS || 120_000),
})

console.log('Valve watchdog started', { cronUrl, pins, pollMs, tripped: watchdog.state.tripped })
const loop = async () => {
  for (;;) {
    const started = monotonicMs()
    try {
      await watchdog.tick()
    } catch (error) {
      console.error('Valve watchdog tick failed', error)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, pollMs - (monotonicMs() - started))))
  }
}
void loop()

import { FastifyReply, FastifyRequest } from 'fastify'
import { SYSTEM_CRON_TIMEOUT_MS, fetchWithTimeout } from './requestTimeout'

let mutationTail: Promise<void> = Promise.resolve()

async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail
  let release!: () => void
  mutationTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

const stoppedConfigPrefixes = [
  '/groups',
  '/zones',
  '/sensors',
  '/valves',
  '/rules',
  '/pairings',
  '/calibrations',
  '/system/board-configs',
  '/system/initialize-sensors',
]

function isConfigMutation(method: string, url: string): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) return false
  if (url === '/valves/operate' || url === '/valves/pulse') return false
  return stoppedConfigPrefixes.some((prefix) => url === prefix || url.startsWith(`${prefix}/`))
}

async function liveControllerState(): Promise<string> {
  const response = await fetchWithTimeout(
    `${process.env.CRON_URL}/state`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    'atomic controller state check',
    SYSTEM_CRON_TIMEOUT_MS,
  )
  if (!response.ok) throw new Error(`cron state returned HTTP ${response.status}`)
  const body = await response.json() as { data?: unknown }
  return String(body?.data || '').toUpperCase()
}

export async function guardedControllerMutation(
  method: string,
  url: string,
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<any> | void,
): Promise<any> {
  const isStateMutation = method.toUpperCase() === 'POST' && url === '/system/state'
  const requiresStopped = isConfigMutation(method, url)
  if (!isStateMutation && !requiresStopped) return handler()

  return runExclusive(async () => {
    if (requiresStopped) {
      let state = ''
      try {
        state = await liveControllerState()
      } catch (error: any) {
        request.log.error(error)
        return reply.code(503).send({
          message: 'Configuration change blocked because live controller state could not be verified',
        })
      }
      if (state !== 'STOPPED') {
        return reply.code(409).send({
          message: `Configuration change requires controller state STOPPED; current state is ${state || 'UNKNOWN'}`,
        })
      }
    }
    return await handler()
  })
}

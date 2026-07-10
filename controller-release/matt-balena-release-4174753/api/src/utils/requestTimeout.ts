import { FastifyReply } from 'fastify'

export class RequestTimeoutError extends Error {
  timeoutMs: number

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = 'RequestTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

function readTimeoutMs(envName: string, fallbackMs: number): number {
  const parsed = Number.parseInt(process.env[envName] || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
}

export const DB_QUERY_TIMEOUT_MS = readTimeoutMs('DB_QUERY_TIMEOUT_MS', 5000)
export const CRON_REQUEST_TIMEOUT_MS = readTimeoutMs('CRON_REQUEST_TIMEOUT_MS', 10000)
export const SYSTEM_CRON_TIMEOUT_MS = readTimeoutMs('SYSTEM_CRON_TIMEOUT_MS', 3000)
export const SENSOR_READ_TIMEOUT_MS = readTimeoutMs('SENSOR_READ_TIMEOUT_MS', 15000)

export async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = DB_QUERY_TIMEOUT_MS
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new RequestTimeoutError(label, timeoutMs)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  label = url,
  timeoutMs = CRON_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new RequestTimeoutError(label, timeoutMs)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function sendApiError(reply: FastifyReply, error: unknown, context: string): void {
  console.error(`${context}:`, error)

  if (error instanceof RequestTimeoutError) {
    reply.code(504).send({
      message: `${context} timed out`,
      timeoutMs: error.timeoutMs,
    })
    return
  }

  reply.code(500).send({ message: 'Internal Server Error' })
}

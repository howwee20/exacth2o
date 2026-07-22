import 'server-only'

import { createHmac, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'

const sessionCookieName = 'exacth2o_controller_session'
const sessionLifetimeSeconds = 8 * 60 * 60

type SessionPayload = {
  userId: string;
  expiresAt: number;
}

function sessionSecret(): string {
  const value = process.env.EXACTH2O_UI_SESSION_SECRET || process.env.DASHBOARD_SESSION_SECRET
  if (!value) throw new Error('Controller UI session authentication is not configured')
  return value
}

function signature(value: string): string {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url')
}

function validSignature(value: string, supplied: string): boolean {
  const expected = Buffer.from(signature(value))
  const received = Buffer.from(supplied)
  return expected.length === received.length && timingSafeEqual(
    new Uint8Array(expected),
    new Uint8Array(received),
  )
}

export async function createUiSession(userId: string): Promise<void> {
  const payload: SessionPayload = {
    userId: String(userId),
    expiresAt: Date.now() + sessionLifetimeSeconds * 1000,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const cookieStore = await cookies()
  cookieStore.set(sessionCookieName, `${encoded}.${signature(encoded)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.DASHBOARD_COOKIE_SECURE !== '0',
    path: '/',
    maxAge: sessionLifetimeSeconds,
  })
}

export async function uiSessionUserId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(sessionCookieName)?.value
  if (!token) return null
  const [encoded, suppliedSignature, extra] = token.split('.')
  if (!encoded || !suppliedSignature || extra || !validSignature(encoded, suppliedSignature)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload
    if (!payload.userId || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) return null
    return String(payload.userId)
  } catch {
    return null
  }
}

export async function requireUiSession(): Promise<string> {
  const userId = await uiSessionUserId()
  if (!userId) throw new Error('Controller UI authentication required')
  return userId
}

export async function clearUiSession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(sessionCookieName)
}

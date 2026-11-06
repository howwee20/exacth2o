type AttemptWindow = {
  count: number
  resetAt: number
}

const attempts = new Map<string, AttemptWindow>()

export function consumeAuthenticationAttempt(
  key: string,
  now: number = Date.now(),
  limit: number = 8,
  windowMs: number = 60_000,
): { allowed: boolean, retryAfterSeconds: number } {
  if (attempts.size > 10_000) {
    for (const [entryKey, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(entryKey)
    }
  }

  const existing = attempts.get(key)
  const entry = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : existing
  entry.count += 1
  attempts.set(key, entry)

  return {
    allowed: entry.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  }
}

export function clearAuthenticationAttempts(key: string): void {
  attempts.delete(key)
}

export function resetAuthenticationRateLimitsForTests(): void {
  attempts.clear()
}

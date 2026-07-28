import {
  clearAuthenticationAttempts,
  consumeAuthenticationAttempt,
  resetAuthenticationRateLimitsForTests,
} from './authenticationRateLimit'

describe('authentication rate limiting', () => {
  beforeEach(resetAuthenticationRateLimitsForTests)

  it('blocks attempts beyond the bounded window', () => {
    const now = Date.UTC(2026, 6, 27, 12)
    expect(consumeAuthenticationAttempt('user@example.com', now, 2).allowed).toBe(true)
    expect(consumeAuthenticationAttempt('user@example.com', now, 2).allowed).toBe(true)
    const blocked = consumeAuthenticationAttempt('user@example.com', now, 2)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBe(60)
  })

  it('resets after the window or a successful authentication', () => {
    const now = Date.UTC(2026, 6, 27, 12)
    consumeAuthenticationAttempt('user@example.com', now, 1)
    expect(consumeAuthenticationAttempt('user@example.com', now, 1).allowed).toBe(false)
    clearAuthenticationAttempts('user@example.com')
    expect(consumeAuthenticationAttempt('user@example.com', now, 1).allowed).toBe(true)
    expect(consumeAuthenticationAttempt('other@example.com', now + 60_001, 1).allowed).toBe(true)
  })
})

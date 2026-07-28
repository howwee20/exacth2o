import { secretsMatch } from './controllerMutationAuth'
import { isControllerMutation } from './controllerMutationGate'

describe('controller mutation authentication', () => {
  it('requires an exact non-empty shared secret', () => {
    expect(secretsMatch('expected-secret', 'expected-secret')).toBe(true)
    expect(secretsMatch('wrong-secret', 'expected-secret')).toBe(false)
    expect(secretsMatch(undefined, 'expected-secret')).toBe(false)
    expect(secretsMatch('expected-secret', undefined)).toBe(false)
  })

  it('allows only the explicitly read-only POST query routes without mutation credentials', () => {
    expect(isControllerMutation('POST', '/logs/search')).toBe(false)
    expect(isControllerMutation('POST', '/readings/filtered')).toBe(false)
    expect(isControllerMutation('POST', '/users/authenticate')).toBe(false)
    expect(isControllerMutation('POST', '/logs')).toBe(true)
    expect(isControllerMutation('POST', '/readings')).toBe(true)
    expect(isControllerMutation('PUT', '/readings/1')).toBe(true)
    expect(isControllerMutation('DELETE', '/logs/1')).toBe(true)
    expect(isControllerMutation('GET', '/pairings')).toBe(false)
  })
})

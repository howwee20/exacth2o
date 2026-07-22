import { secretsMatch } from './controllerMutationAuth'

describe('controller mutation authentication', () => {
  it('requires an exact non-empty shared secret', () => {
    expect(secretsMatch('expected-secret', 'expected-secret')).toBe(true)
    expect(secretsMatch('wrong-secret', 'expected-secret')).toBe(false)
    expect(secretsMatch(undefined, 'expected-secret')).toBe(false)
    expect(secretsMatch('expected-secret', undefined)).toBe(false)
  })
})

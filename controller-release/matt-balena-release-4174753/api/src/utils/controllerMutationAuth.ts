import { timingSafeEqual } from 'crypto'

export function secretsMatch(supplied: string | undefined, expected: string | undefined): boolean {
  if (!supplied || !expected) return false
  const suppliedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(
    new Uint8Array(suppliedBytes),
    new Uint8Array(expectedBytes),
  )
}

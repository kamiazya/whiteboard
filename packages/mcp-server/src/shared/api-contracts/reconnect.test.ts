import { describe, expect, it } from 'vitest'
import { ecP256PublicJwkSchema, reconnectSessionRequestSchema } from './reconnect.js'

// Direct unit coverage of the base64url byte-length validation that gates
// both the JWK x/y coordinates and the session signature — the route-level
// tests only exercise a couple of concrete cases indirectly, leaving the
// character-set rejection and the length%4==1 remainder branch unverified.
describe('exactByteLengthBase64Url (via ecP256PublicJwkSchema)', () => {
  const validJwkBase = { kty: 'EC' as const, crv: 'P-256' as const }
  // 32 bytes of zero, base64url-encoded — a syntactically valid, correctly
  // sized placeholder coordinate for the fields under test.
  const validCoord = 'A'.repeat(43)

  it('rejects a coordinate containing a character outside the base64url alphabet', () => {
    const result = ecP256PublicJwkSchema.safeParse({
      ...validJwkBase,
      x: `${'A'.repeat(42)}+`, // '+' is base64 standard, not base64url
      y: validCoord,
    })
    expect(result.success).toBe(false)
  })

  it('rejects a coordinate whose length modulo 4 is 1 (never a whole number of bytes)', () => {
    const result = ecP256PublicJwkSchema.safeParse({
      ...validJwkBase,
      x: 'A'.repeat(41), // 41 % 4 === 1
      y: validCoord,
    })
    expect(result.success).toBe(false)
  })

  it('accepts a coordinate that decodes to exactly 32 bytes', () => {
    const result = ecP256PublicJwkSchema.safeParse({
      ...validJwkBase,
      x: validCoord,
      y: validCoord,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a coordinate one byte short of 32', () => {
    const result = ecP256PublicJwkSchema.safeParse({
      ...validJwkBase,
      x: validCoord.slice(0, -1),
      y: validCoord,
    })
    expect(result.success).toBe(false)
  })
})

describe('reconnectSessionRequestSchema signature validation', () => {
  it('rejects a signature containing invalid base64url characters', () => {
    const result = reconnectSessionRequestSchema.safeParse({
      challengeId: 'challenge-1',
      signature: `${'A'.repeat(85)}/`, // '/' is base64 standard, not base64url
    })
    expect(result.success).toBe(false)
  })

  it('accepts a signature that decodes to exactly 64 bytes', () => {
    const result = reconnectSessionRequestSchema.safeParse({
      challengeId: 'challenge-1',
      signature: 'A'.repeat(86), // 86 base64url chars decode to 64 bytes
    })
    expect(result.success).toBe(true)
  })
})

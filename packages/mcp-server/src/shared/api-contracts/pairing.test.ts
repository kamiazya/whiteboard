/**
 * Roundtrip serialization tests for the pairing api-contract schemas.
 *
 * Each test verifies three invariants:
 *   1. A well-formed value parses successfully.
 *   2. JSON stringify → parse → schema.parse produces an equal result
 *      (no field drift through the wire format).
 *   3. A malformed / missing-required / extra-field value is rejected by
 *      safeParse (the schemas are `.strict()`, so an unexpected field is
 *      itself a drift signal).
 *
 * z.infer type alignment is checked at the TypeScript level by annotating
 * parsed results with the exported type alias.
 */
import { describe, expect, it } from 'vitest'
import {
  type PairingTokenResponse,
  pairingTokenNonceSchema,
  pairingTokenRequestSchema,
  pairingTokenResponseSchema,
} from './pairing.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('pairingTokenResponseSchema', () => {
  const valid: PairingTokenResponse = {
    token: 'tok-123',
    expiresAt: '2099-01-01T00:00:00.000Z',
    origin: 'https://latest.kamiazya-whiteboard.pages.dev',
  }

  it('parses a well-formed value without identity', () => {
    const result: PairingTokenResponse = pairingTokenResponseSchema.parse(valid)
    expect(result).toEqual(valid)
  })

  it('roundtrip preserves fields without identity', () => {
    const result: PairingTokenResponse = roundtrip(pairingTokenResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('roundtrip preserves fields with an identity signature', () => {
    const withIdentity: PairingTokenResponse = {
      ...valid,
      identity: { alg: 'Ed25519', publicKey: 'pk-abc', signature: 'sig-xyz' },
    }
    const result: PairingTokenResponse = roundtrip(pairingTokenResponseSchema, withIdentity)
    expect(result).toEqual(withIdentity)
  })

  it('rejects a missing required field (token)', () => {
    const { token: _omit, ...missing } = valid
    expect(pairingTokenResponseSchema.safeParse(missing).success).toBe(false)
  })

  it('rejects a missing required field (origin)', () => {
    const { origin: _omit, ...missing } = valid
    expect(pairingTokenResponseSchema.safeParse(missing).success).toBe(false)
  })

  it('rejects an unexpected extra field (strict schema catches server drift)', () => {
    expect(pairingTokenResponseSchema.safeParse({ ...valid, extra: 'unexpected' }).success).toBe(
      false,
    )
  })

  it('rejects an incomplete identity object', () => {
    expect(
      pairingTokenResponseSchema.safeParse({ ...valid, identity: { alg: 'Ed25519' } }).success,
    ).toBe(false)
  })
})

describe('pairingTokenRequestSchema', () => {
  it('parses and roundtrips a code grant', () => {
    const valid = { grantType: 'code' as const, code: 'c1', codeVerifier: 'v1' }
    const result = pairingTokenRequestSchema.parse(valid)
    expect(result).toEqual(valid)
    expect(roundtrip(pairingTokenRequestSchema, { ...valid, nonce: undefined })).toEqual(valid)
  })

  it('parses and roundtrips an origin grant', () => {
    const valid = { grantType: 'origin' as const }
    const result = roundtrip(pairingTokenRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects a code grant missing codeVerifier', () => {
    expect(pairingTokenRequestSchema.safeParse({ grantType: 'code', code: 'c1' }).success).toBe(
      false,
    )
  })

  it('rejects an unknown grantType', () => {
    expect(pairingTokenRequestSchema.safeParse({ grantType: 'other' }).success).toBe(false)
  })
})

describe('pairingTokenNonceSchema bounds', () => {
  function nonceOfBytes(byteLength: number): string {
    return Buffer.alloc(byteLength, 7).toString('base64url')
  }

  it('accepts nonces that decode to 16-32 bytes', () => {
    expect(pairingTokenNonceSchema.safeParse(nonceOfBytes(16)).success).toBe(true)
    expect(pairingTokenNonceSchema.safeParse(nonceOfBytes(32)).success).toBe(true)
  })

  it('rejects a nonce one byte short of the minimum', () => {
    expect(pairingTokenNonceSchema.safeParse(nonceOfBytes(15)).success).toBe(false)
  })

  it('rejects a nonce one byte over the maximum', () => {
    expect(pairingTokenNonceSchema.safeParse(nonceOfBytes(33)).success).toBe(false)
  })

  it('rejects a non-base64url string', () => {
    expect(pairingTokenNonceSchema.safeParse('not base64url!!!').success).toBe(false)
  })
})

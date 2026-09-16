/**
 * The daemon-side verifier for a WebAuthn assertion — ADR-0039's evidence
 * that a person was present, checked here against a pinned P-256 key.
 *
 * Every assertion in this file is BUILT rather than recorded, from a fresh
 * keypair and the same layout an authenticator emits: `authenticatorData`
 * (rpIdHash || flags || signCount) and `clientDataJSON`, signed as ES256 over
 * `authenticatorData || SHA-256(clientDataJSON)` with a DER signature. That is
 * what makes the tamper property honest — it can flip any bit anywhere and
 * know the verifier, not the fixture, is what refused it.
 */
import { createHash, sign as cryptoSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { attestationSchema } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import {
  decodeAttestation,
  parseAuthenticatorData,
  verifyWebAuthnAssertion,
} from './webauthn-assertion.js'

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10

const sha256 = (input: Uint8Array | string): Buffer => createHash('sha256').update(input).digest()
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  return {
    privateKey,
    publicKeyJwk: { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x, y: jwk.y },
  }
}

interface BuildInput {
  privateKey: KeyObject
  rpId: string
  origin: string
  challenge: Uint8Array
  flags: number
  signCount: number
  type?: string
}

function build({
  privateKey,
  rpId,
  origin,
  challenge,
  flags,
  signCount,
  type = 'webauthn.get',
}: BuildInput) {
  const authenticatorData = Buffer.alloc(37)
  sha256(rpId).copy(authenticatorData, 0)
  authenticatorData[32] = flags
  authenticatorData.writeUInt32BE(signCount, 33)
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type, challenge: b64u(challenge), origin, crossOrigin: false }),
  )
  const signature = cryptoSign(
    'sha256',
    Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
    privateKey,
  )
  return { authenticatorData, clientDataJSON, signature }
}

const rpIdArb = fc.constantFrom('kamiazya-whiteboard.pages.dev', 'localhost', 'example.test')
const challengeArb = fc.uint8Array({ minLength: 16, maxLength: 64 })
const signCountArb = fc.integer({ min: 0, max: 0xffffffff })
// The three combinations the spec allows; BE=0 with BS=1 is the one it forbids.
const backupArb = fc.constantFrom(
  { be: false, bs: false },
  { be: true, bs: false },
  { be: true, bs: true },
)

describe('verifyWebAuthnAssertion', () => {
  fcTest.prop([rpIdArb, challengeArb, signCountArb, backupArb], withDefaults({ numRuns: 60 }))(
    'accepts what a real authenticator would emit, and reports the flags it carried',
    (rpId, challenge, signCount, { be, bs }) => {
      const { privateKey, publicKeyJwk } = keypair()
      const origin = `https://${rpId}`
      const flags = UP | UV | (be ? BE : 0) | (bs ? BS : 0)
      const assertion = build({ privateKey, rpId, origin, challenge, flags, signCount })

      const verdict = verifyWebAuthnAssertion(assertion, { challenge, origin, rpId, publicKeyJwk })

      expect(verdict).toEqual({ ok: true, backupEligible: be, backupState: bs, signCount })
    },
  )

  fcTest.prop(
    [rpIdArb, challengeArb, fc.constantFrom(0, 1, 2), fc.nat()],
    withDefaults({ numRuns: 100 }),
  )(
    'rejects a single flipped bit anywhere in any of the three parts',
    (rpId, challenge, part, seed) => {
      const { privateKey, publicKeyJwk } = keypair()
      const origin = `https://${rpId}`
      const assertion = build({ privateKey, rpId, origin, challenge, flags: UP | UV, signCount: 7 })
      const target = [assertion.authenticatorData, assertion.clientDataJSON, assertion.signature][
        part
      ]
      if (target === undefined) throw new Error('unreachable')
      const tampered = Buffer.from(target)
      const bit = seed % (tampered.length * 8)
      tampered[Math.floor(bit / 8)] ^= 1 << (bit % 8)
      const parts = [assertion.authenticatorData, assertion.clientDataJSON, assertion.signature]
      parts[part] = tampered

      const verdict = verifyWebAuthnAssertion(
        { authenticatorData: parts[0], clientDataJSON: parts[1], signature: parts[2] },
        { challenge, origin, rpId, publicKeyJwk },
      )

      expect(verdict.ok).toBe(false)
    },
  )

  // Each check has its own reason, so a refusal says which expectation the
  // assertion failed rather than only that it failed.
  const rpId = 'kamiazya-whiteboard.pages.dev'
  const origin = `https://${rpId}`
  const challenge = Buffer.from('0123456789abcdef0123456789abcdef')

  function valid() {
    const { privateKey, publicKeyJwk } = keypair()
    return {
      privateKey,
      publicKeyJwk,
      assertion: build({ privateKey, rpId, origin, challenge, flags: UP | UV, signCount: 1 }),
    }
  }

  it('names a wrong challenge', () => {
    const { assertion, publicKeyJwk } = valid()
    const other = Buffer.from('fedcba9876543210fedcba9876543210')
    expect(
      verifyWebAuthnAssertion(assertion, { challenge: other, origin, rpId, publicKeyJwk }),
    ).toEqual({
      ok: false,
      reason: 'challenge',
    })
  })

  it('names a wrong origin', () => {
    const { assertion, publicKeyJwk } = valid()
    expect(
      verifyWebAuthnAssertion(assertion, {
        challenge,
        origin: 'https://evil.test',
        rpId,
        publicKeyJwk,
      }),
    ).toEqual({ ok: false, reason: 'origin' })
  })

  it('names a wrong rpId', () => {
    const { assertion, publicKeyJwk } = valid()
    expect(
      verifyWebAuthnAssertion(assertion, { challenge, origin, rpId: 'other.test', publicKeyJwk }),
    ).toEqual({ ok: false, reason: 'rpIdHash' })
  })

  it('refuses the registration ceremony where an assertion is expected', () => {
    const { privateKey, publicKeyJwk } = keypair()
    const assertion = build({
      privateKey,
      rpId,
      origin,
      challenge,
      flags: UP | UV,
      signCount: 1,
      type: 'webauthn.create',
    })
    expect(verifyWebAuthnAssertion(assertion, { challenge, origin, rpId, publicKeyJwk })).toEqual({
      ok: false,
      reason: 'type',
    })
  })

  it('requires user presence', () => {
    const { privateKey, publicKeyJwk } = keypair()
    const assertion = build({ privateKey, rpId, origin, challenge, flags: UV, signCount: 1 })
    expect(verifyWebAuthnAssertion(assertion, { challenge, origin, rpId, publicKeyJwk })).toEqual({
      ok: false,
      reason: 'userPresence',
    })
  })

  // The whole of ADR-0039 rests on this bit: an agent on the page can press
  // the button (UP) and cannot satisfy user verification (UV).
  it('requires user verification, not merely presence', () => {
    const { privateKey, publicKeyJwk } = keypair()
    const assertion = build({ privateKey, rpId, origin, challenge, flags: UP, signCount: 1 })
    expect(verifyWebAuthnAssertion(assertion, { challenge, origin, rpId, publicKeyJwk })).toEqual({
      ok: false,
      reason: 'userVerification',
    })
  })

  it('refuses the backup-flag combination the spec forbids (BE=0, BS=1)', () => {
    const { privateKey, publicKeyJwk } = keypair()
    const assertion = build({
      privateKey,
      rpId,
      origin,
      challenge,
      flags: UP | UV | BS,
      signCount: 1,
    })
    expect(verifyWebAuthnAssertion(assertion, { challenge, origin, rpId, publicKeyJwk })).toEqual({
      ok: false,
      reason: 'backupFlags',
    })
  })

  it('names a signature under a different key', () => {
    const { assertion } = valid()
    const { publicKeyJwk: otherKey } = keypair()
    expect(
      verifyWebAuthnAssertion(assertion, { challenge, origin, rpId, publicKeyJwk: otherKey }),
    ).toEqual({
      ok: false,
      reason: 'signature',
    })
  })

  it('answers malformed for input it cannot read, rather than throwing', () => {
    const { publicKeyJwk } = keypair()
    const expectation = { challenge, origin, rpId, publicKeyJwk }
    const short = {
      authenticatorData: Buffer.alloc(36),
      clientDataJSON: Buffer.from('{}'),
      signature: Buffer.alloc(0),
    }
    expect(verifyWebAuthnAssertion(short, expectation)).toEqual({ ok: false, reason: 'malformed' })
    const notJson = {
      authenticatorData: Buffer.alloc(37),
      clientDataJSON: Buffer.from('not json'),
      signature: Buffer.alloc(0),
    }
    expect(verifyWebAuthnAssertion(notJson, expectation)).toEqual({
      ok: false,
      reason: 'malformed',
    })
    const missingFields = {
      authenticatorData: Buffer.alloc(37),
      clientDataJSON: Buffer.from('{"type":"webauthn.get"}'),
      signature: Buffer.alloc(0),
    }
    expect(verifyWebAuthnAssertion(missingFields, expectation)).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })
})

describe('attestationSchema and decodeAttestation', () => {
  fcTest.prop([rpIdArb, challengeArb, signCountArb], withDefaults({ numRuns: 40 }))(
    'round-trips the wire shape to the same bytes, which still verify',
    (rpId, challenge, signCount) => {
      const { privateKey, publicKeyJwk } = keypair()
      const origin = `https://${rpId}`
      const assertion = build({ privateKey, rpId, origin, challenge, flags: UP | UV, signCount })

      const wire = attestationSchema.parse({
        kind: 'webauthn',
        credentialId: b64u(Buffer.from('credential-id')),
        authenticatorData: b64u(assertion.authenticatorData),
        clientDataJSON: b64u(assertion.clientDataJSON),
        signature: b64u(assertion.signature),
      })
      const decoded = decodeAttestation(wire)

      expect(Buffer.from(decoded.authenticatorData).equals(assertion.authenticatorData)).toBe(true)
      expect(Buffer.from(decoded.clientDataJSON).equals(assertion.clientDataJSON)).toBe(true)
      expect(Buffer.from(decoded.signature).equals(assertion.signature)).toBe(true)
      expect(verifyWebAuthnAssertion(decoded, { challenge, origin, rpId, publicKeyJwk }).ok).toBe(
        true,
      )
    },
  )

  fcTest.prop(
    [
      fc
        .array(
          fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'),
          { minLength: 1, maxLength: 12 },
        )
        .map((chars) => chars.join('')),
    ],
    withDefaults({ numRuns: 200 }),
  )('accepts exactly the strings that decode and re-encode to themselves', (value) => {
    const accepted = attestationSchema.safeParse({
      kind: 'webauthn',
      credentialId: value,
      authenticatorData: 'AAAA',
      clientDataJSON: 'AAAA',
      signature: 'AAAA',
    }).success
    // Node's decoder is lenient, so re-encoding is what tells a canonical
    // spelling from a second spelling of the same bytes.
    expect(accepted).toBe(Buffer.from(value, 'base64url').toString('base64url') === value)
  })

  it('refuses a non-canonical tail: an impossible length, or unused bits that are not zero', () => {
    const wire = (credentialId: string) => ({
      kind: 'webauthn',
      credentialId,
      authenticatorData: 'AAAA',
      clientDataJSON: 'AAAA',
      signature: 'AAAA',
    })
    for (const bad of ['A', 'AB', 'AAB', 'AAAAA']) {
      expect(attestationSchema.safeParse(wire(bad)).success, bad).toBe(false)
    }
    for (const good of ['AQ', 'AA', 'AAE', 'AAAA', '_w']) {
      expect(attestationSchema.safeParse(wire(good)).success, good).toBe(true)
    }
  })

  it('refuses padded or non-base64url fields', () => {
    const base = {
      kind: 'webauthn',
      credentialId: 'abc',
      authenticatorData: 'abc',
      clientDataJSON: 'abc',
      signature: 'abc',
    }
    expect(attestationSchema.safeParse({ ...base, signature: 'ab==' }).success).toBe(false)
    expect(attestationSchema.safeParse({ ...base, signature: 'a+b/c' }).success).toBe(false)
    expect(attestationSchema.safeParse({ ...base, signature: '' }).success).toBe(false)
    expect(attestationSchema.safeParse({ ...base, kind: 'other' }).success).toBe(false)
  })
})

/**
 * Registration authenticatorData: the assertion layout plus, under the AT
 * flag, the attested credential data — aaguid (16) || credentialIdLength (2)
 * || credentialId || a COSE key this parser does not read (the key reaches
 * the daemon as SPKI, which `node:crypto` already understands).
 */
function registrationAuthData({
  rpId,
  flags,
  signCount,
  credentialId,
  coseKeyBytes = Buffer.alloc(77),
}: {
  rpId: string
  flags: number
  signCount: number
  credentialId: Uint8Array
  coseKeyBytes?: Buffer
}): Buffer {
  const head = Buffer.alloc(37)
  sha256(rpId).copy(head, 0)
  head[32] = flags
  head.writeUInt32BE(signCount, 33)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(credentialId.length, 0)
  return Buffer.concat([head, Buffer.alloc(16, 0xaa), length, credentialId, coseKeyBytes])
}

describe('parseAuthenticatorData', () => {
  const AT = 0x40
  const rpId = 'kamiazya-whiteboard.pages.dev'
  const origin = `https://${rpId}`
  const challenge = Buffer.from('0123456789abcdef0123456789abcdef')
  const credentialIdArb = fc.uint8Array({ minLength: 16, maxLength: 64 })

  fcTest.prop(
    [rpIdArb, signCountArb, credentialIdArb, fc.boolean(), fc.boolean()],
    withDefaults({ numRuns: 60 }),
  )(
    'reads the flags, the count and the attested credential id back',
    (rpId, signCount, credentialId, be, uv) => {
      const flags = UP | (uv ? UV : 0) | (be ? BE : 0) | AT
      const parsed = parseAuthenticatorData(
        registrationAuthData({ rpId, flags, signCount, credentialId }),
      )
      expect(parsed).not.toBeNull()
      expect(Buffer.from(parsed?.rpIdHash ?? []).equals(sha256(rpId))).toBe(true)
      expect(parsed?.flags).toEqual({
        userPresent: true,
        userVerified: uv,
        backupEligible: be,
        backupState: false,
      })
      expect(parsed?.signCount).toBe(signCount)
      expect(Buffer.from(parsed?.credentialId ?? []).equals(Buffer.from(credentialId))).toBe(true)
    },
  )

  it('reports no credential id for an assertion, whose AT flag is clear', () => {
    const parsed = parseAuthenticatorData(
      build({ ...keypair(), rpId, origin, challenge, flags: UP | UV, signCount: 3 })
        .authenticatorData,
    )
    expect(parsed?.credentialId).toBeUndefined()
    expect(parsed?.signCount).toBe(3)
  })

  it('answers null for bytes too short for what their flags promise', () => {
    expect(parseAuthenticatorData(Buffer.alloc(36))).toBeNull()
    const truncated = registrationAuthData({
      rpId,
      flags: UP | UV | AT,
      signCount: 1,
      credentialId: Buffer.alloc(32, 1),
    }).subarray(0, 37 + 16 + 2 + 10)
    expect(parseAuthenticatorData(truncated)).toBeNull()
    // AT set with nothing after the header at all.
    const bare = Buffer.alloc(37)
    bare[32] = UP | AT
    expect(parseAuthenticatorData(bare)).toBeNull()
  })
})

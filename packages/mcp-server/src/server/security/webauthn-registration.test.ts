import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { verifyWebAuthnRegistration } from './webauthn-registration.js'

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40

const sha256 = (input: string | Uint8Array) => createHash('sha256').update(input).digest()
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

function authData(rpId: string, flags: number, credentialId: Uint8Array, signCount = 0): Buffer {
  const head = Buffer.alloc(37)
  sha256(rpId).copy(head, 0)
  head[32] = flags
  head.writeUInt32BE(signCount, 33)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(credentialId.length, 0)
  return Buffer.concat([head, Buffer.alloc(16), length, credentialId, Buffer.alloc(77)])
}

function spki(namedCurve = 'P-256'): { spki: Buffer; jwk: { x: string; y: string } } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  return { spki: publicKey.export({ format: 'der', type: 'spki' }), jwk }
}

const rpId = 'kamiazya-whiteboard.pages.dev'
const credentialId = Buffer.from('a-credential-id-of-16')

describe('verifyWebAuthnRegistration', () => {
  fcTest.prop(
    [
      fc.constantFrom('kamiazya-whiteboard.pages.dev', 'localhost'),
      fc.uint8Array({ minLength: 16, maxLength: 64 }),
      fc.boolean(),
      fc.integer({ min: 0, max: 0xffffffff }),
    ],
    withDefaults({ numRuns: 40 }),
  )('pins the P-256 key and the flags a real registration carries', (rp, id, be, signCount) => {
    const key = spki()
    const verdict = verifyWebAuthnRegistration(
      {
        credentialId: b64u(id),
        publicKey: b64u(key.spki),
        authenticatorData: b64u(authData(rp, UP | UV | AT | (be ? BE : 0), id, signCount)),
      },
      { rpId: rp },
    )
    expect(verdict).toEqual({
      ok: true,
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: key.jwk.x, y: key.jwk.y },
      backupEligible: be,
      signCount,
    })
  })

  it('refuses each thing a registration can get wrong, naming it', () => {
    const key = spki()
    const good = {
      credentialId: b64u(credentialId),
      publicKey: b64u(key.spki),
      authenticatorData: b64u(authData(rpId, UP | UV | AT, credentialId)),
    }
    expect(verifyWebAuthnRegistration(good, { rpId }).ok).toBe(true)

    // The request names one credential and the authenticator another.
    expect(
      verifyWebAuthnRegistration(
        { ...good, credentialId: b64u(Buffer.from('another-id-16!!')) },
        { rpId },
      ),
    ).toEqual({ ok: false, reason: 'credentialId' })
    // Registered against a different relying party than the origin implies.
    expect(verifyWebAuthnRegistration(good, { rpId: 'evil.example' })).toEqual({
      ok: false,
      reason: 'rpIdHash',
    })
    expect(
      verifyWebAuthnRegistration(
        { ...good, authenticatorData: b64u(authData(rpId, UP | AT, credentialId)) },
        { rpId },
      ),
    ).toEqual({ ok: false, reason: 'userVerification' })
    expect(
      verifyWebAuthnRegistration(
        { ...good, authenticatorData: b64u(authData(rpId, UV | AT, credentialId)) },
        { rpId },
      ),
    ).toEqual({ ok: false, reason: 'userPresence' })
    expect(
      verifyWebAuthnRegistration(
        { ...good, authenticatorData: b64u(authData(rpId, UP | UV | AT | BS, credentialId)) },
        { rpId },
      ),
    ).toEqual({ ok: false, reason: 'backupFlags' })
    // An assertion's authenticatorData (no AT) is not a registration.
    expect(
      verifyWebAuthnRegistration(
        { ...good, authenticatorData: b64u(authData(rpId, UP | UV, credentialId).subarray(0, 37)) },
        { rpId },
      ),
    ).toEqual({ ok: false, reason: 'malformed' })
    // A key that is not P-256: another curve, an Ed25519 key, and bytes.
    expect(
      verifyWebAuthnRegistration({ ...good, publicKey: b64u(spki('P-384').spki) }, { rpId }),
    ).toEqual({ ok: false, reason: 'publicKey' })
    const ed = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' })
    expect(verifyWebAuthnRegistration({ ...good, publicKey: b64u(ed) }, { rpId })).toEqual({
      ok: false,
      reason: 'publicKey',
    })
    expect(verifyWebAuthnRegistration({ ...good, publicKey: 'AAAA' }, { rpId })).toEqual({
      ok: false,
      reason: 'publicKey',
    })
  })
})

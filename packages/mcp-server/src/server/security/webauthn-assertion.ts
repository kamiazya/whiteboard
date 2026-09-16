/**
 * Verifies a WebAuthn assertion against a pinned P-256 key — the daemon's
 * half of ADR-0039's evidence that a person was present.
 *
 * What is checked, in the order the spec's §7.2 lists it and a refusal names
 * it: the ceremony type, the challenge, the origin, the rpId hash, the UP and
 * UV flags, the backup-flag pair, and finally the ES256 signature over
 * `authenticatorData || SHA-256(clientDataJSON)`. UV is REQUIRED, not merely
 * UP: the whole of ADR-0039 rests on the fact that an agent on the page can
 * press the button and cannot satisfy user verification, so an assertion
 * without UV proves nothing this verifier exists to prove.
 *
 * Total: every input answers a verdict, and malformed bytes answer
 * `malformed` rather than throwing — the same contract the codec parsers
 * keep, since what reaches this function came off the wire.
 *
 * The key is a JWK handed in by the caller, never read from the assertion.
 * That mirrors `daemon-identity-pin.ts` in the browser, which verifies the
 * daemon against the key it PINNED and never against one a responder
 * advertises; here the daemon pins the browser's credential at pairing and
 * verifies against that. An assertion cannot bring its own key.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import type { Attestation } from '@kamiazya/whiteboard-server-core'
import { z } from 'zod'

export interface WebAuthnAssertionBytes {
  readonly authenticatorData: Uint8Array
  readonly clientDataJSON: Uint8Array
  readonly signature: Uint8Array
}

/** The pinned public key, in the JWK shape `crypto.subtle.exportKey('jwk')` produces. */
// A type alias rather than an interface: Node's `JsonWebKey` carries an index
// signature, which an interface is not assignable to and an alias is.
type P256PublicKeyJwk = {
  readonly kty: 'EC'
  readonly crv: 'P-256'
  readonly x: string
  readonly y: string
}

export interface AssertionExpectation {
  readonly challenge: Uint8Array
  readonly origin: string
  readonly rpId: string
  readonly publicKeyJwk: P256PublicKeyJwk
}

type AssertionRefusal =
  | 'malformed'
  | 'type'
  | 'challenge'
  | 'origin'
  | 'rpIdHash'
  | 'userPresence'
  | 'userVerification'
  | 'backupFlags'
  | 'signature'

export type AssertionVerdict =
  | { ok: true; backupEligible: boolean; backupState: boolean; signCount: number }
  | { ok: false; reason: AssertionRefusal }

// authenticatorData: rpIdHash (32) || flags (1) || signCount (4) || …
const AUTHENTICATOR_DATA_MIN_BYTES = 37
const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10

// The three fields §5.8.1 makes mandatory. Not `.strict()`: `crossOrigin`,
// `tokenBinding` and future keys are the spec's to add, and refusing them
// would refuse a conforming authenticator.
const clientDataSchema = z.object({
  type: z.string(),
  challenge: z.string(),
  origin: z.string(),
})

const sha256 = (input: Uint8Array | string): Buffer => createHash('sha256').update(input).digest()

const refuse = (reason: AssertionRefusal): AssertionVerdict => ({ ok: false, reason })

/** The wire shape back to the bytes the verifier reads. */
export function decodeAttestation(attestation: Attestation): WebAuthnAssertionBytes {
  return {
    authenticatorData: Buffer.from(attestation.authenticatorData, 'base64url'),
    clientDataJSON: Buffer.from(attestation.clientDataJSON, 'base64url'),
    signature: Buffer.from(attestation.signature, 'base64url'),
  }
}

export function verifyWebAuthnAssertion(
  assertion: WebAuthnAssertionBytes,
  expectation: AssertionExpectation,
): AssertionVerdict {
  const authenticatorData = Buffer.from(assertion.authenticatorData)
  if (authenticatorData.length < AUTHENTICATOR_DATA_MIN_BYTES) return refuse('malformed')

  let clientJson: unknown
  try {
    clientJson = JSON.parse(Buffer.from(assertion.clientDataJSON).toString('utf8'))
  } catch {
    return refuse('malformed')
  }
  const client = clientDataSchema.safeParse(clientJson)
  if (!client.success) return refuse('malformed')

  if (client.data.type !== 'webauthn.get') return refuse('type')
  if (client.data.challenge !== Buffer.from(expectation.challenge).toString('base64url')) {
    return refuse('challenge')
  }
  if (client.data.origin !== expectation.origin) return refuse('origin')
  if (!authenticatorData.subarray(0, 32).equals(sha256(expectation.rpId))) return refuse('rpIdHash')

  const flags = authenticatorData[32] ?? 0
  if ((flags & FLAG_UP) === 0) return refuse('userPresence')
  if ((flags & FLAG_UV) === 0) return refuse('userVerification')
  const backupEligible = (flags & FLAG_BE) !== 0
  const backupState = (flags & FLAG_BS) !== 0
  // A credential that cannot be backed up cannot report itself as backed up.
  if (!backupEligible && backupState) return refuse('backupFlags')

  const signed = Buffer.concat([authenticatorData, sha256(assertion.clientDataJSON)])
  let valid = false
  try {
    const key = createPublicKey({ key: expectation.publicKeyJwk, format: 'jwk' })
    // WebAuthn ES256 signatures are DER-encoded ECDSA, not raw r||s.
    valid = cryptoVerify(
      'sha256',
      signed,
      { key, dsaEncoding: 'der' },
      Buffer.from(assertion.signature),
    )
  } catch {
    valid = false
  }
  if (!valid) return refuse('signature')

  return {
    ok: true,
    backupEligible,
    backupState,
    signCount: authenticatorData.readUInt32BE(33),
  }
}

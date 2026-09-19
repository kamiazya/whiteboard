/**
 * What the daemon checks before PINNING a credential a paired origin
 * registered (ADR-0039): that the key is the P-256 key a passkey signs ES256
 * with, that the registration's `authenticatorData` names the same credential
 * the request does and the relying party the origin implies, and that the
 * gesture that created it satisfied user verification — so the credential
 * is one an assertion can later satisfy UV with, and a registration on an
 * authenticator that never will fails HERE, not at the promote it was
 * meant for.
 *
 * The key arrives as SPKI (`response.getPublicKey()`), which `node:crypto`
 * parses natively; reading it out of the COSE key inside the attestation
 * object would need a CBOR decoder for the same bytes. No attestation
 * STATEMENT is verified: the daemon is not judging the authenticator's
 * make, only pinning a key from an origin it already trusts.
 */
import { createHash, createPublicKey } from 'node:crypto'
import {
  type P256PublicKeyJwk,
  p256PublicKeyJwkSchema,
  parseAuthenticatorData,
} from './webauthn-assertion.js'

export interface RegistrationInput {
  /** Base64url, as the request carries them. */
  readonly credentialId: string
  readonly publicKey: string
  readonly authenticatorData: string
}

type RegistrationRefusal =
  | 'malformed'
  | 'credentialId'
  | 'rpIdHash'
  | 'userPresence'
  | 'userVerification'
  | 'backupFlags'
  | 'publicKey'

export type RegistrationVerdict =
  | { ok: true; publicKeyJwk: P256PublicKeyJwk; backupEligible: boolean; signCount: number }
  | { ok: false; reason: RegistrationRefusal }

const refuse = (reason: RegistrationRefusal): RegistrationVerdict => ({ ok: false, reason })

function p256JwkFromSpki(spki: Buffer): P256PublicKeyJwk | null {
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec') return null
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null
    const parsed = p256PublicKeyJwkSchema.safeParse(key.export({ format: 'jwk' }))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function verifyWebAuthnRegistration(
  input: RegistrationInput,
  expectation: { readonly rpId: string },
): RegistrationVerdict {
  const parsed = parseAuthenticatorData(Buffer.from(input.authenticatorData, 'base64url'))
  if (parsed === null || parsed.credentialId === undefined) return refuse('malformed')
  if (Buffer.from(parsed.credentialId).toString('base64url') !== input.credentialId) {
    return refuse('credentialId')
  }
  const rpIdHash = createHash('sha256').update(expectation.rpId).digest()
  if (!Buffer.from(parsed.rpIdHash).equals(rpIdHash)) return refuse('rpIdHash')
  if (!parsed.flags.userPresent) return refuse('userPresence')
  if (!parsed.flags.userVerified) return refuse('userVerification')
  if (!parsed.flags.backupEligible && parsed.flags.backupState) return refuse('backupFlags')
  const publicKeyJwk = p256JwkFromSpki(Buffer.from(input.publicKey, 'base64url'))
  if (publicKeyJwk === null) return refuse('publicKey')
  return {
    ok: true,
    publicKeyJwk,
    backupEligible: parsed.flags.backupEligible,
    signCount: parsed.signCount,
  }
}

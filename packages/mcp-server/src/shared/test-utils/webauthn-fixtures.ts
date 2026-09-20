/**
 * A real P-256 WebAuthn ceremony, built rather than recorded, shared between
 * every test that needs one: the assertion verifier's own property suite,
 * the pairing routes' registration fixture, and the session-assert route
 * that exercises the full pin -> challenge -> assertion path. A fixture
 * duplicated per file is how two copies drift — this is the one definition.
 */
import { createHash, sign as cryptoSign, generateKeyPairSync, type KeyObject } from 'node:crypto'

export const WEBAUTHN_FLAG_UP = 0x01
export const WEBAUTHN_FLAG_UV = 0x04
export const WEBAUTHN_FLAG_BE = 0x08
export const WEBAUTHN_FLAG_BS = 0x10
const FLAG_AT = 0x40

const sha256 = (input: Uint8Array | string): Buffer => createHash('sha256').update(input).digest()
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

export interface P256KeyPair {
  readonly privateKey: KeyObject
  readonly publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
}

/** A fresh P-256 keypair, exported the shape `crypto.subtle.exportKey('jwk')` would. */
export function p256Keypair(): P256KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  return {
    privateKey,
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
  }
}

export interface BuildAssertionInput {
  readonly privateKey: KeyObject
  readonly rpId: string
  readonly origin: string
  readonly challenge: Uint8Array
  readonly flags: number
  readonly signCount: number
  readonly type?: string
}

/** An assertion's wire bytes: `authenticatorData` (rpIdHash || flags ||
 *  signCount), `clientDataJSON`, and a DER ES256 signature over
 *  `authenticatorData || SHA-256(clientDataJSON)` — the layout a real
 *  authenticator emits. */
export function buildAssertion({
  privateKey,
  rpId,
  origin,
  challenge,
  flags,
  signCount,
  type = 'webauthn.get',
}: BuildAssertionInput): {
  authenticatorData: Buffer
  clientDataJSON: Buffer
  signature: Buffer
} {
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

export interface RegistrationAuthDataInput {
  readonly rpId: string
  readonly flags: number
  readonly signCount: number
  readonly credentialId: Uint8Array
  readonly coseKeyBytes?: Buffer
}

/** Registration authenticatorData: the assertion layout plus, under the AT
 *  flag, the attested credential data — aaguid (16) || credentialIdLength (2)
 *  || credentialId || a COSE key nothing here reads (the daemon receives the
 *  key as SPKI, which `node:crypto` parses without a CBOR decoder). */
export function registrationAuthData({
  rpId,
  flags,
  signCount,
  credentialId,
  coseKeyBytes = Buffer.alloc(77),
}: RegistrationAuthDataInput): Buffer {
  const head = Buffer.alloc(37)
  sha256(rpId).copy(head, 0)
  head[32] = flags
  head.writeUInt32BE(signCount, 33)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(credentialId.length, 0)
  return Buffer.concat([head, Buffer.alloc(16, 0xaa), length, credentialId, coseKeyBytes])
}

/** A registration as `navigator.credentials.create()` would hand the page it
 *  — the wire shape `registerCredentialRequestSchema` reads, built from a
 *  fresh keypair whose PRIVATE half the caller keeps, so a later test can
 *  sign an assertion against the same pin. */
export function registrationFor(
  rpId: string,
  { uv = true }: { uv?: boolean } = {},
): { credentialId: string; publicKey: string; authenticatorData: string; keypair: P256KeyPair } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const keypair: P256KeyPair = { privateKey, publicKeyJwk: { kty: 'EC', crv: 'P-256', ...jwk } }
  const credentialId = Buffer.from(`credential-for-${rpId}`)
  const head = Buffer.alloc(37)
  sha256(rpId).copy(head, 0)
  head[32] = WEBAUTHN_FLAG_UP | (uv ? WEBAUTHN_FLAG_UV : 0) | WEBAUTHN_FLAG_BE | FLAG_AT
  const length = Buffer.alloc(2)
  length.writeUInt16BE(credentialId.length, 0)
  return {
    credentialId: credentialId.toString('base64url'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    authenticatorData: Buffer.concat([
      head,
      Buffer.alloc(16),
      length,
      credentialId,
      Buffer.alloc(77),
    ]).toString('base64url'),
    keypair,
  }
}

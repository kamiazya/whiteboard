/**
 * Browser half of daemon mutual authentication: pin the daemon's Ed25519
 * public key at /pair consent time, then verify every later signed response
 * against the PIN — never against whatever key a responder advertises. A
 * port-squatting local process serving its own key fails the pinned
 * verification and is refused (fail closed; the pin is kept so the
 * key-changed warning has its evidence, per the approved design).
 */
import { z } from 'zod'

const PINS_KEY = 'whiteboard:daemon-identity-pins'

const pinSchema = z
  .object({
    alg: z.literal('Ed25519'),
    publicKey: z.string().min(1),
    pinnedAt: z.string(),
  })
  .strict()

const pinsFileSchema = z.record(z.string(), pinSchema)

export type DaemonIdentityPin = z.infer<typeof pinSchema>

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function loadPins(storage: StorageLike): Record<string, DaemonIdentityPin> {
  const raw = storage.getItem(PINS_KEY)
  if (raw === null) return {}
  try {
    return pinsFileSchema.parse(JSON.parse(raw))
  } catch {
    // A corrupt pin store must not brick pairing: treated as no pins, and
    // the next successful consent re-pins.
    return {}
  }
}

export function getPinnedIdentity(
  daemonBaseUrl: string,
  storage: StorageLike = globalThis.localStorage,
): DaemonIdentityPin | null {
  return loadPins(storage)[daemonBaseUrl.replace(/\/+$/, '')] ?? null
}

export function pinIdentity(
  daemonBaseUrl: string,
  identity: { alg: 'Ed25519'; publicKey: string },
  storage: StorageLike = globalThis.localStorage,
): void {
  const pins = loadPins(storage)
  storage.setItem(
    PINS_KEY,
    JSON.stringify({
      ...pins,
      [daemonBaseUrl.replace(/\/+$/, '')]: { ...identity, pinnedAt: new Date().toISOString() },
    }),
  )
}

export function createChallengeNonce(): string {
  const buffer = new Uint8Array(24)
  crypto.getRandomValues(buffer)
  return btoa(String.fromCharCode(...buffer))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

// Must byte-match the daemon's buildSignedPayload (JSON-array encoding gives
// unambiguous part boundaries; first part is the domain-separation tag).
function buildSignedPayload(parts: readonly string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(parts))
}

export async function verifyIdentitySignature({
  publicKey,
  parts,
  signature,
}: {
  publicKey: string
  parts: readonly string[]
  signature: string
}): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    // Uint8Array views satisfy BufferSource at runtime; TS lib DOM typing of
    // verify() is stricter than the spec here.
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      base64UrlToBytes(signature) as BufferSource,
      buildSignedPayload(parts) as BufferSource,
    )
  } catch {
    // Unsupported algorithm or malformed key material: verification failed,
    // never a throw — callers treat this exactly like a bad signature.
    return false
  }
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

const FINGERPRINT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Short human-checkable fingerprint of a daemon public key: first 40 bits of
 * sha256(raw key), base32, grouped as XXXX-XXXX. Shown on the /pair consent
 * page and the Storage tab so a user can cross-check out-of-band.
 */
export async function fingerprintPublicKey(publicKey: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', base64UrlToBytes(publicKey) as BufferSource),
  )
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of digest) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < 8) {
      bits -= 5
      out += FINGERPRINT_ALPHABET[(acc >> bits) & 31]
    }
    if (out.length >= 8) break
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`
}

export type IdentityChallengeResult = 'verified' | 'failed' | 'unpinned'

/**
 * Challenges a loopback responder to prove it holds the PINNED daemon's
 * private key (POST /api/runtime/verify with a fresh nonce, signature over
 * ["wb-verify-v1", nonce, origin]). 'unpinned' when this browser never
 * pinned that baseUrl (nothing to verify against — the caller keeps its
 * cautious copy). Any non-verifying answer from a pinned responder —
 * wrong key, bad signature, missing route, network failure — is 'failed':
 * a daemon we once pinned MUST be able to answer its own challenge, so
 * the absence of proof is treated as no proof.
 */
export async function challengeDaemonIdentity({
  daemonBaseUrl,
  fetch,
  hostedOrigin = globalThis.location.origin,
  storage = globalThis.localStorage,
}: {
  daemonBaseUrl: string
  fetch: typeof globalThis.fetch
  hostedOrigin?: string
  storage?: StorageLike
}): Promise<IdentityChallengeResult> {
  const pinned = getPinnedIdentity(daemonBaseUrl, storage)
  if (pinned === null) return 'unpinned'
  const nonce = createChallengeNonce()
  try {
    const response = await fetch(`${daemonBaseUrl.replace(/\/+$/, '')}/api/runtime/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    })
    if (!response.ok) return 'failed'
    const body = (await response.json()) as { publicKey?: unknown; signature?: unknown }
    const verified =
      body.publicKey === pinned.publicKey &&
      typeof body.signature === 'string' &&
      (await verifyIdentitySignature({
        publicKey: pinned.publicKey,
        parts: ['wb-verify-v1', nonce, hostedOrigin],
        signature: body.signature,
      }))
    return verified ? 'verified' : 'failed'
  } catch {
    return 'failed'
  }
}

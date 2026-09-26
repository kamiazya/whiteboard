/**
 * Browser half of daemon mutual authentication: pin the daemon's Ed25519
 * public key at /pair consent time, then verify every later signed response
 * against the PIN — never against whatever key a responder advertises. A
 * port-squatting local process serving its own key fails the pinned
 * verification and is refused (fail closed; the pin is kept so the
 * key-changed warning has its evidence, per the approved design).
 */
import { runtimeVerifyResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { z } from 'zod'

const PINS_KEY = 'whiteboard:daemon-identity-pins'

const pinSchema = z
  .object({
    alg: z.literal('Ed25519'),
    publicKey: z.string().min(1),
    pinnedAt: z.string(),
  })
  .strict()

export type DaemonIdentityPin = z.infer<typeof pinSchema>

/**
 * What this browser knows about one daemon's identity. `unreadable` is a pin
 * that is THERE but that this build cannot parse — a newer build's field
 * under `.strict()`, or a damaged store. It is kept apart from `none` because
 * `none` is what sends renewal down the unverified path: reading one as the
 * other would accept a token from whatever answers on the pinned port. So it
 * fails closed like a key mismatch, and the user's next consent re-pins it.
 */
export type PinLookup =
  | { kind: 'none' }
  | { kind: 'pinned'; pin: DaemonIdentityPin }
  | { kind: 'unreadable' }

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function normalize(daemonBaseUrl: string): string {
  return daemonBaseUrl.replace(/\/+$/, '')
}

/** The stored entries, unparsed, or `unreadable` when the store is not a JSON object. */
function rawPins(storage: StorageLike): Record<string, unknown> | 'unreadable' {
  const raw = storage.getItem(PINS_KEY)
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'unreadable'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable'
  return parsed as Record<string, unknown>
}

export function readPinnedIdentity(
  daemonBaseUrl: string,
  storage: StorageLike = globalThis.localStorage,
): PinLookup {
  const pins = rawPins(storage)
  if (pins === 'unreadable') return { kind: 'unreadable' }
  const key = normalize(daemonBaseUrl)
  if (!Object.hasOwn(pins, key)) return { kind: 'none' }
  const pin = pinSchema.safeParse(pins[key])
  return pin.success ? { kind: 'pinned', pin: pin.data } : { kind: 'unreadable' }
}

/**
 * Entries this build cannot read are written back as they were: dropping
 * one would turn that daemon's pin into no pin. A store that is not a JSON
 * object has no entries to keep and is replaced.
 */
// ponytail: replacing a non-object store forgets which OTHER daemons were
// pinned, so they renew unverified until re-paired; only this app writes the
// key, so the store being garbage at all is already a damaged profile.
export function pinIdentity(
  daemonBaseUrl: string,
  identity: { alg: 'Ed25519'; publicKey: string },
  storage: StorageLike = globalThis.localStorage,
): void {
  const pins = rawPins(storage)
  storage.setItem(
    PINS_KEY,
    JSON.stringify({
      ...(pins === 'unreadable' ? {} : pins),
      [normalize(daemonBaseUrl)]: { ...identity, pinnedAt: new Date().toISOString() },
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
 * cautious copy); a pin it cannot read is 'failed', not 'unpinned'. Any non-verifying answer from a pinned responder —
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
  const lookup = readPinnedIdentity(daemonBaseUrl, storage)
  if (lookup.kind === 'none') return 'unpinned'
  if (lookup.kind === 'unreadable') return 'failed'
  const pinned = lookup.pin
  const nonce = createChallengeNonce()
  try {
    const response = await fetch(`${daemonBaseUrl.replace(/\/+$/, '')}/api/runtime/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    })
    if (!response.ok) return 'failed'
    // safeParse against the shared wire contract, not a hand-cast: an
    // algorithm change (alg !== 'Ed25519') or any other drift from the
    // daemon's actual response shape must fail closed rather than silently
    // dropping the unrecognized field and verifying anyway.
    const parsed = runtimeVerifyResponseSchema.safeParse(await response.json())
    if (!parsed.success) return 'failed'
    const body = parsed.data
    const verified =
      body.publicKey === pinned.publicKey &&
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

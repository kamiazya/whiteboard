/**
 * The daemon's Ed25519 identity, named the way the rest of the world names a
 * key: `did:key:z6Mk…`.
 *
 * This is a REPRESENTATION, not a new credential. `daemonIdentitySchema`'s
 * `publicKey` stays the raw base64url key it has always been, the daemon's
 * keypair is untouched, and nothing about pinning or verification changes —
 * see ADR-0035 decision 1, which fixes the key to the device and gives it a
 * portable name rather than moving it.
 *
 * Why it sits beside the wire contract rather than in `model`: today its only
 * subject is the value `runtime.ts` carries. ADR-0035 decision 2 anticipates
 * device DIDs reaching documents, and when that happens this belongs one
 * layer down — a move inside the monorepo, not a break.
 *
 * The encodings are deliberately NOT hand-rolled. A `did:key` IS multibase
 * plus multicodec, and `multiformats` is their reference implementation:
 * `base58btc` carries the `z` prefix itself (and rejects any other multibase),
 * `varint` reads the codec header. The argument is not cryptographic — base58
 * holds no secret and has no timing property — it is coverage: a hand-written
 * base58's leading-zero branches are unreachable from this call site, so no
 * test here can ever exercise them.
 */
import { varint } from 'multiformats'
import { base58btc } from 'multiformats/bases/base58'

// multiformats/multicodec table.csv: `ed25519-pub, key, 0xed`.
const ED25519_PUB_CODE = 0xed
const ED25519_PUBLIC_KEY_BYTES = 32

const DID_KEY_PREFIX = 'did:key:'

// btoa/atob rather than Buffer: this package runs in the browser too, and
// `pairing-link.ts` beside it already takes the same route for the same
// reason.
function base64UrlToBytes(value: string): Uint8Array | null {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * The raw Ed25519 public key `daemonIdentitySchema` carries, as a `did:key`.
 * Null when the input is not base64url or not 32 bytes — total rather than
 * throwing, matching how every other parser in this package answers a value
 * it cannot read.
 */
export function ed25519PublicKeyToDidKey(publicKeyBase64Url: string): string | null {
  const key = base64UrlToBytes(publicKeyBase64Url)
  if (key === null || key.length !== ED25519_PUBLIC_KEY_BYTES) return null

  const headerLength = varint.encodingLength(ED25519_PUB_CODE)
  const bytes = new Uint8Array(headerLength + key.length)
  varint.encodeTo(ED25519_PUB_CODE, bytes)
  bytes.set(key, headerLength)
  return `${DID_KEY_PREFIX}${base58btc.encode(bytes)}`
}

/**
 * Back to the raw base64url key, so a verifier can hand it to
 * `crypto.subtle.importKey` without learning multicodec.
 *
 * Null for any DID that is not an Ed25519 `did:key` — including a well-formed
 * one carrying a different multicodec, which would otherwise name a key of
 * the wrong KIND with a string that looks right.
 */
export function didKeyToEd25519PublicKey(did: string): string | null {
  if (!did.startsWith(DID_KEY_PREFIX)) return null
  // Both throw on input they cannot read (a non-`z` multibase, a character
  // outside the alphabet, a truncated codec header); this seam answers null.
  try {
    const bytes = base58btc.decode(did.slice(DID_KEY_PREFIX.length))
    const [code, headerLength] = varint.decode(bytes)
    if (code !== ED25519_PUB_CODE) return null
    const key = bytes.subarray(headerLength)
    if (key.length !== ED25519_PUBLIC_KEY_BYTES) return null
    return bytesToBase64Url(key)
  } catch {
    return null
  }
}

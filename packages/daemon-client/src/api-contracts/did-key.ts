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
 * Deliberately dependency-free. base58btc is base conversion, not
 * cryptography: no secret, no timing property, and a published test vector
 * either round-trips or it does not. `did-key.test.ts` checks it against
 * identifiers the method's own spec published, so agreeing with itself is not
 * enough to pass.
 */

// multiformats/multicodec table.csv: `ed25519-pub, key, 0xed`. 0xed exceeds a
// single varint byte (> 0x7f), so it encodes as two: low seven bits with the
// continuation bit set, then the remainder.
const ED25519_MULTICODEC = Uint8Array.of(0xed, 0x01)
const ED25519_PUBLIC_KEY_BYTES = 32

// Multibase prefix `z` selects base58btc. It is part of the identifier, not
// decoration — a different prefix means a different alphabet.
const DID_KEY_PREFIX = 'did:key:z'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const BASE58_INDEX: ReadonlyMap<string, number> = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, index]),
)

/**
 * Bitcoin-style base58: repeated division of the whole byte string, with
 * leading zero bytes carried across as leading `1`s rather than falling out
 * of the arithmetic (0 is not a digit that survives a base change).
 */
function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1

  // log(256)/log(58) ≈ 1.365; 138/100 is the conventional safe over-estimate.
  const size = Math.floor(((bytes.length - zeros) * 138) / 100) + 1
  const digits = new Uint8Array(size)
  let length = 0

  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]
    let used = 0
    for (let k = size - 1; (carry !== 0 || used < length) && k >= 0; k -= 1, used += 1) {
      carry += 256 * digits[k]
      digits[k] = carry % 58
      carry = Math.floor(carry / 58)
    }
    length = used
  }

  let start = size - length
  while (start < size && digits[start] === 0) start += 1

  let encoded = '1'.repeat(zeros)
  for (let i = start; i < size; i += 1) encoded += BASE58_ALPHABET[digits[i]]
  return encoded
}

/** Inverse of {@link base58Encode}. Null for any character outside the alphabet. */
function base58Decode(value: string): Uint8Array | null {
  if (value.length === 0) return new Uint8Array(0)
  let zeros = 0
  while (zeros < value.length && value[zeros] === '1') zeros += 1

  // log(58)/log(256) ≈ 0.733, the same over-estimate in the other direction.
  const size = Math.floor(((value.length - zeros) * 733) / 1000) + 1
  const bytes = new Uint8Array(size)
  let length = 0

  for (let i = zeros; i < value.length; i += 1) {
    const digit = BASE58_INDEX.get(value[i])
    if (digit === undefined) return null
    let carry = digit
    let used = 0
    for (let k = size - 1; (carry !== 0 || used < length) && k >= 0; k -= 1, used += 1) {
      carry += 58 * bytes[k]
      bytes[k] = carry % 256
      carry = Math.floor(carry / 256)
    }
    length = used
  }

  let start = size - length
  while (start < size && bytes[start] === 0) start += 1

  const decoded = new Uint8Array(zeros + (size - start))
  decoded.set(bytes.subarray(start), zeros)
  return decoded
}

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

  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + key.length)
  prefixed.set(ED25519_MULTICODEC, 0)
  prefixed.set(key, ED25519_MULTICODEC.length)
  return `${DID_KEY_PREFIX}${base58Encode(prefixed)}`
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
  const decoded = base58Decode(did.slice(DID_KEY_PREFIX.length))
  if (decoded === null) return null
  if (decoded.length !== ED25519_MULTICODEC.length + ED25519_PUBLIC_KEY_BYTES) return null
  if (decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]) return null
  return bytesToBase64Url(decoded.subarray(ED25519_MULTICODEC.length))
}

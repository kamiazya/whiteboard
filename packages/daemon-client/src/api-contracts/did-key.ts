/**
 * The daemon's Ed25519 identity, named the way the rest of the world names a
 * key: `did:key:z6Mk…`.
 *
 * This is a REPRESENTATION, not a new credential. `daemonIdentitySchema`'s
 * `publicKey` stays the raw base64url key it has always been, the daemon's
 * keypair is untouched, and nothing about pinning or verification changes —
 * see ADR-0035 decision 1, which fixes the key to the device and gives it a
 * portable name rather than moving it. The name is how the versions the daemon
 * saves name it as their actor (ADR-0035 decision 2); the ping advertises the
 * raw key alone, so nothing decodes a `did:key` back and no decoder is kept.
 *
 * The encodings are deliberately NOT hand-rolled. A `did:key` IS multibase
 * plus multicodec, and `multiformats` is their reference implementation:
 * `base58btc` carries the `z` prefix itself and `varint` writes the codec
 * header. The argument is not cryptographic — base58
 * holds no secret and has no timing property — it is coverage: a hand-written
 * base58's leading-zero branches are unreachable from this call site, so no
 * test here can ever exercise them.
 */
import { base64UrlToBytes } from '@kamiazya/whiteboard-model'
import { varint } from 'multiformats'
import { base58btc } from 'multiformats/bases/base58'

// multiformats/multicodec table.csv: `ed25519-pub, key, 0xed`.
const ED25519_PUB_CODE = 0xed
const ED25519_PUBLIC_KEY_BYTES = 32

const DID_KEY_PREFIX = 'did:key:'

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

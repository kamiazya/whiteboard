/**
 * The vectors below are REAL `did:key` identifiers published by the method's
 * own spec and by an independent implementation — not values this codec
 * produced. That direction matters: a codec tested only against its own
 * output agrees with itself while disagreeing with everyone else, which is
 * the one failure a DID representation exists to avoid.
 *
 * Sources, fetched 2026-09-12:
 *   w3c-ccg/did-method-key   index.html   (the method spec's own examples)
 *   digitalbazaar/did-method-key README.md (an independent implementation)
 *
 * The multicodec constant is likewise sourced rather than recalled:
 * multiformats/multicodec table.csv gives `ed25519-pub, key, 0xed`.
 */
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { didKeyToEd25519PublicKey, ed25519PublicKeyToDidKey } from './did-key.js'

const SPEC_DID_KEYS = [
  'did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP',
  'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  'did:key:z6MknCCLeeHBUaHu4aHSVLDCYQW9gjVJ7a63FpMvtuVMy53T',
  'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
] as const

describe('did:key — against identifiers this codec did not produce', () => {
  // The load-bearing case. If base58 or the multicodec prefix is wrong, a
  // published identifier will not survive decode-then-encode, and no amount
  // of internal consistency hides it.
  it.each(SPEC_DID_KEYS)('round-trips %s byte-for-byte', (did) => {
    const publicKey = didKeyToEd25519PublicKey(did)
    expect(publicKey, 'a published Ed25519 did:key must decode').not.toBeNull()
    expect(ed25519PublicKeyToDidKey(publicKey as string)).toBe(did)
  })

  it.each(SPEC_DID_KEYS)('decodes %s to exactly 32 key bytes', (did) => {
    const publicKey = didKeyToEd25519PublicKey(did) as string
    // base64url of 32 bytes is 43 unpadded characters.
    expect(publicKey).toHaveLength(43)
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('ed25519PublicKeyToDidKey', () => {
  // Not cosmetic: `z6Mk` is what the fixed multicodec header (0xed 0x01)
  // plus a 32-byte key always base58-encodes to, so it fails the moment the
  // header is wrong — which is how this reads as a check rather than a
  // restatement of the format.
  fcTest.prop([fc.uint8Array({ minLength: 32, maxLength: 32 })], withDefaults())(
    'every Ed25519 key yields a did:key beginning z6Mk, and round-trips',
    (keyBytes) => {
      const publicKey = bytesToBase64Url(keyBytes)
      const did = ed25519PublicKeyToDidKey(publicKey)
      expect(did).not.toBeNull()
      expect(did as string).toMatch(/^did:key:z6Mk/)
      expect(didKeyToEd25519PublicKey(did as string)).toBe(publicKey)
    },
  )

  it('refuses a key that is not 32 bytes', () => {
    expect(ed25519PublicKeyToDidKey(bytesToBase64Url(new Uint8Array(31)))).toBeNull()
    expect(ed25519PublicKeyToDidKey(bytesToBase64Url(new Uint8Array(33)))).toBeNull()
  })

  it('refuses input that is not base64url', () => {
    expect(ed25519PublicKeyToDidKey('not base64url!!')).toBeNull()
  })
})

describe('didKeyToEd25519PublicKey', () => {
  it.each([
    ['a non-did string', 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'],
    ['another DID method', 'did:web:example.com'],
    ['a multibase prefix other than z', 'did:key:f6Mkhaxg'],
    ['a character outside the base58 alphabet', 'did:key:z6Mkhax0OIl'],
    ['an empty method-specific id', 'did:key:z'],
  ])('refuses %s', (_label, input) => {
    expect(didKeyToEd25519PublicKey(input)).toBeNull()
  })

  // x25519-pub is 0xec in the same multicodec table — one byte away from
  // ed25519-pub, and a key-agreement key rather than a signing one. Accepting
  // it would mean naming the wrong kind of key with the right-looking string.
  it('refuses a well-formed did:key whose multicodec is not ed25519-pub', () => {
    const x25519 = new Uint8Array(34)
    x25519[0] = 0xec
    x25519[1] = 0x01
    const did = `did:key:z${base58EncodeForTest(x25519)}`
    expect(didKeyToEd25519PublicKey(did)).toBeNull()
  })
})

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

// A deliberately separate, naive base58 encoder for the ONE fixture that has
// to be built rather than quoted. Sharing the implementation under test would
// make that case agree with whatever the codec does.
function base58EncodeForTest(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let out = ''
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out
    value /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    out = `1${out}`
  }
  return out
}

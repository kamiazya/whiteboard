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
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { ed25519PublicKeyToDidKey } from './did-key.js'

// Each published identifier beside the raw key it names, the key read off the
// identifier's own bytes (multicodec header 0xed 0x01, then 32 key bytes).
const SPEC_DID_KEYS = [
  [
    'did:key:z6Mkf5rGMoatrSj1f4CyvuHBeXJELe9RPdzo2PKGNCKVtZxP',
    'CV-aGlld3nVdgnhoZK0D36Wk-9aIMlZjZOK2XhPMnkQ',
  ],
  [
    'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    'Lm_M42cB3HkUiODQsXRcweM6TByfzEHGO9ND274JcOY',
  ],
  [
    'did:key:z6MknCCLeeHBUaHu4aHSVLDCYQW9gjVJ7a63FpMvtuVMy53T',
    'cwGXz9hryEvuEo-cBcLTBWnnr9kBjx2_1xTMndtgth4',
  ],
  [
    'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
    'lJZrfAjkBXdfjebMHEUI9usidAPhAlssitLXR3OYxbI',
  ],
] as const

describe('did:key — against identifiers this codec did not produce', () => {
  // The load-bearing case. If base58 or the multicodec prefix is wrong, the
  // key will not encode to the identifier everyone else publishes for it,
  // and no amount of internal consistency hides it.
  it.each(SPEC_DID_KEYS)('encodes to %s byte-for-byte', (did, publicKey) => {
    expect(ed25519PublicKeyToDidKey(publicKey)).toBe(did)
  })
})

describe('ed25519PublicKeyToDidKey', () => {
  // Not cosmetic: `z6Mk` is what the fixed multicodec header (0xed 0x01)
  // plus a 32-byte key always base58-encodes to, so it fails the moment the
  // header is wrong — which is how this reads as a check rather than a
  // restatement of the format.
  fcTest.prop([fc.uint8Array({ minLength: 32, maxLength: 32 })], withDefaults())(
    'every Ed25519 key yields a did:key beginning z6Mk',
    (keyBytes) => {
      const did = ed25519PublicKeyToDidKey(bytesToBase64Url(keyBytes))
      expect(did).not.toBeNull()
      expect(did as string).toMatch(/^did:key:z6Mk/)
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

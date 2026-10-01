/**
 * The codec is a serializer, so the properties are round trips plus an
 * independent oracle: Node's `Buffer` agrees on every VALID string, and a
 * hand-written grammar (not the codec's own checks) decides which strings are
 * valid. `Buffer` is the oracle only — the module under test never touches it.
 */
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url } from './base64.js'

const anyBytes = fc.uint8Array({ maxLength: 300 })

// Dense over the characters that decide validity, so a random string reaches
// both the valid grammar and each way of falling off it.
const nearBase64 = fc.string({
  unit: fc.constantFrom(...'ABZaz059+/-_= \n!'.split('')),
  maxLength: 12,
})

const STANDARD_GRAMMAR = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/
const URL_GRAMMAR = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}(?:==)?|[A-Za-z0-9_-]{3}=?)?$/

describe('base64 codec properties', () => {
  fcTest.prop([anyBytes], withDefaults())('round-trips both variants', (input) => {
    expect(base64ToBytes(bytesToBase64(input))).toEqual(input)
    expect(base64UrlToBytes(bytesToBase64Url(input))).toEqual(input)
  })

  fcTest.prop([anyBytes], withDefaults())('encodes the way Node does', (input) => {
    expect(bytesToBase64(input)).toBe(Buffer.from(input).toString('base64'))
    expect(bytesToBase64Url(input)).toBe(Buffer.from(input).toString('base64url'))
  })

  fcTest.prop([anyBytes], withDefaults())('the url variant never writes +, / or =', (input) => {
    expect(bytesToBase64Url(input)).toMatch(/^[A-Za-z0-9_-]*$/)
  })

  fcTest.prop([anyBytes], withDefaults())('decodes padded and unpadded text alike', (input) => {
    const padded = Buffer.from(input).toString('base64')
    const unpadded = padded.replace(/=+$/, '')
    expect(base64ToBytes(padded)).toEqual(input)
    expect(base64ToBytes(unpadded)).toEqual(input)
    expect(base64UrlToBytes(padded.replaceAll('+', '-').replaceAll('/', '_'))).toEqual(input)
    expect(base64UrlToBytes(unpadded.replaceAll('+', '-').replaceAll('/', '_'))).toEqual(input)
  })

  fcTest.prop([nearBase64], withDefaults())(
    'standard decoding is total: null exactly off the grammar, Node’s bytes on it',
    (text) => {
      const decoded = base64ToBytes(text)
      if (STANDARD_GRAMMAR.test(text)) {
        expect(decoded).toEqual(new Uint8Array(Buffer.from(text, 'base64')))
      } else {
        expect(decoded).toBeNull()
      }
    },
  )

  fcTest.prop([nearBase64], withDefaults())(
    'url decoding is total: null exactly off the grammar, Node’s bytes on it',
    (text) => {
      const decoded = base64UrlToBytes(text)
      if (URL_GRAMMAR.test(text)) {
        expect(decoded).toEqual(new Uint8Array(Buffer.from(text, 'base64url')))
      } else {
        expect(decoded).toBeNull()
      }
    },
  )

  fcTest.prop(
    [anyBytes.filter((b) => b.length > 0), fc.nat(), fc.constantFrom('!', ' ', '*', '.')],
    withDefaults(),
  )(
    'a valid string with one character swapped for a non-alphabet one is refused',
    (input, at, junk) => {
      const text = bytesToBase64Url(input)
      const index = at % text.length
      const broken = text.slice(0, index) + junk + text.slice(index + 1)
      expect(base64UrlToBytes(broken)).toBeNull()
      expect(base64ToBytes(broken)).toBeNull()
    },
  )
})

import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { bytesToHex } from './hex.js'

describe('bytesToHex', () => {
  it('writes the fixed vectors, lowercase and zero-padded', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('')
    expect(bytesToHex(new Uint8Array([0, 15, 16, 171, 255]))).toBe('000f10abff')
  })

  // The oracle reads the text back by parsing it, not by running the writer
  // the other way.
  fcTest.prop([fc.uint8Array({ maxLength: 200 })], withDefaults())(
    'is two lowercase hex digits per byte, each parsing back to that byte',
    (input) => {
      const text = bytesToHex(input)
      expect(text).toMatch(/^(?:[0-9a-f]{2})*$/)
      const parsed = (text.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16))
      expect(parsed).toEqual([...input])
    },
  )
})

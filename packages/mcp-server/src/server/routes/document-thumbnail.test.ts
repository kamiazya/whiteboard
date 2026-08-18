import { describe, expect, it } from 'vitest'
import { isValidPngSignature } from './document-thumbnail.js'

const VALID_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe('isValidPngSignature', () => {
  it('accepts valid PNG header', () => {
    expect(isValidPngSignature(new Uint8Array(VALID_HEADER))).toBe(true)
  })

  it('accepts PNG header with trailing data', () => {
    expect(isValidPngSignature(new Uint8Array([...VALID_HEADER, 0, 0, 0]))).toBe(true)
  })

  it('rejects empty buffer', () => {
    expect(isValidPngSignature(new Uint8Array(0))).toBe(false)
  })

  it('rejects buffer shorter than 8 bytes', () => {
    for (let len = 0; len < 8; len++) {
      expect(isValidPngSignature(new Uint8Array(len))).toBe(false)
    }
  })

  it('rejects mutation of any signature byte', () => {
    for (const i of VALID_HEADER.keys()) {
      const mutated = [...VALID_HEADER]
      mutated[i] = 0x00
      expect(isValidPngSignature(new Uint8Array(mutated))).toBe(false)
    }
  })
})

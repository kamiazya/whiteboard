import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256.js'

describe('sha256Hex', () => {
  it('matches the published SHA-256 test vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes bytes and the same text identically', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'))
  })

  it('hashes a string as UTF-8, not as code units', () => {
    expect(sha256Hex('é')).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])))
  })
})

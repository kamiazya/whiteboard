import { describe, expect, it } from 'vitest'
import { blobRefSchema } from './blob-store.js'

const validDigest = '0'.repeat(64)

describe('blobRefSchema', () => {
  it('accepts sha-256 with a 64-char lowercase hex digest', () => {
    expect(blobRefSchema.safeParse({ algorithm: 'sha-256', digestHex: validDigest }).success).toBe(
      true,
    )
  })

  it('rejects a digest that is the wrong length', () => {
    expect(
      blobRefSchema.safeParse({ algorithm: 'sha-256', digestHex: '0'.repeat(63) }).success,
    ).toBe(false)
    expect(
      blobRefSchema.safeParse({ algorithm: 'sha-256', digestHex: '0'.repeat(65) }).success,
    ).toBe(false)
  })

  it('rejects an uppercase-hex digest', () => {
    expect(
      blobRefSchema.safeParse({ algorithm: 'sha-256', digestHex: 'A'.repeat(64) }).success,
    ).toBe(false)
  })

  it('rejects a non-sha-256 algorithm', () => {
    expect(blobRefSchema.safeParse({ algorithm: 'md5', digestHex: validDigest }).success).toBe(
      false,
    )
  })

  it('rejects an extra unknown key (strict)', () => {
    expect(
      blobRefSchema.safeParse({ algorithm: 'sha-256', digestHex: validDigest, extra: 1 }).success,
    ).toBe(false)
  })
})

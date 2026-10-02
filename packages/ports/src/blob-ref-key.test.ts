import { describe, expect, it } from 'vitest'
import { blobRefKey } from './blob-ref-key.js'

describe('blobRefKey', () => {
  it('is the algorithm and the digest, so another algorithm cannot collide with a sha-256 hex', () => {
    const digestHex = 'ab'.repeat(32)
    expect(blobRefKey({ algorithm: 'sha-256', digestHex })).toBe(`sha-256:${digestHex}`)
  })
})

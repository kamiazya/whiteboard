import { describe, expect, it } from 'vitest'
import { deltaBatchSchema } from './delta.js'

describe('deltaBatchSchema', () => {
  it('accepts a batch with one or more updates and a frontier', () => {
    const result = deltaBatchSchema.safeParse({
      updates: [new Uint8Array([1])],
      newFrontier: new Uint8Array([9]),
    })
    expect(result.success).toBe(true)
  })

  it('rejects an empty updates array', () => {
    expect(
      deltaBatchSchema.safeParse({ updates: [], newFrontier: new Uint8Array([9]) }).success,
    ).toBe(false)
  })

  it('rejects an updates element that is not a Uint8Array', () => {
    expect(
      deltaBatchSchema.safeParse({ updates: ['not-bytes'], newFrontier: new Uint8Array([9]) })
        .success,
    ).toBe(false)
  })

  it('rejects a malformed newFrontier', () => {
    expect(
      deltaBatchSchema.safeParse({ updates: [new Uint8Array([1])], newFrontier: 'abc' }).success,
    ).toBe(false)
  })

  it('rejects an extra unknown key (strict)', () => {
    expect(
      deltaBatchSchema.safeParse({
        updates: [new Uint8Array([1])],
        newFrontier: new Uint8Array([9]),
        extra: 1,
      }).success,
    ).toBe(false)
  })
})

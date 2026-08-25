import { describe, expect, it } from 'vitest'
import { COMPACT_DELTA_BYTES, deltaBatchSchema, shouldCompact } from './delta.js'

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

// ---- fold policy ----

const compactBytes = (n: number) => new Uint8Array(n)

describe('shouldCompact', () => {
  // The threshold is a measurement, not a preference: at ~64KB of deltas the
  // replay a fresh open pays is ~10ms and the storage waste is ~10x the
  // folded snapshot. Both keep growing without a bound.
  it('folds once the log passes the measured budget', () => {
    expect(shouldCompact([compactBytes(COMPACT_DELTA_BYTES + 1)])).toBe(true)
    expect(shouldCompact([compactBytes(COMPACT_DELTA_BYTES)])).toBe(false)
  })

  // Size, not count: one pasted document and a thousand drags cost wildly
  // different bytes, and it is the bytes that are replayed and stored.
  it('counts bytes rather than entries', () => {
    const manyTiny = Array.from({ length: 5_000 }, () => compactBytes(1))
    expect(shouldCompact(manyTiny)).toBe(false)
    expect(shouldCompact([compactBytes(COMPACT_DELTA_BYTES + 1)])).toBe(true)
  })

  it('sums the whole log, not just the newest entry', () => {
    const half = Math.ceil(COMPACT_DELTA_BYTES / 2) + 1
    expect(shouldCompact([compactBytes(half), compactBytes(half)])).toBe(true)
  })

  it('leaves an empty or absent log alone', () => {
    expect(shouldCompact([])).toBe(false)
    expect(shouldCompact(undefined)).toBe(false)
  })
})

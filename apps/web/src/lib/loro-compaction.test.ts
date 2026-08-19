import { describe, expect, it } from 'vitest'
import { COMPACT_DELTA_BYTES, shouldCompact } from './loro-compaction.js'

const bytes = (n: number) => new Uint8Array(n)

describe('shouldCompact', () => {
  // The threshold is a measurement, not a preference: at ~64KB of deltas the
  // replay a fresh open pays is ~10ms and the storage waste is ~10x the
  // folded snapshot. Both keep growing without a bound.
  it('folds once the log passes the measured budget', () => {
    expect(shouldCompact([bytes(COMPACT_DELTA_BYTES + 1)])).toBe(true)
    expect(shouldCompact([bytes(COMPACT_DELTA_BYTES)])).toBe(false)
  })

  // Size, not count: one pasted document and a thousand drags cost wildly
  // different bytes, and it is the bytes that are replayed and stored.
  it('counts bytes rather than entries', () => {
    const manyTiny = Array.from({ length: 5_000 }, () => bytes(1))
    expect(shouldCompact(manyTiny)).toBe(false)
    expect(shouldCompact([bytes(COMPACT_DELTA_BYTES + 1)])).toBe(true)
  })

  it('sums the whole log, not just the newest entry', () => {
    const half = Math.ceil(COMPACT_DELTA_BYTES / 2) + 1
    expect(shouldCompact([bytes(half), bytes(half)])).toBe(true)
  })

  it('leaves an empty or absent log alone', () => {
    expect(shouldCompact([])).toBe(false)
    expect(shouldCompact(undefined)).toBe(false)
  })
})

// @vitest-environment node
/**
 * The bytes a record read back out of IndexedDB must parse through is pinned
 * directly: a structured clone DROPS symbol-keyed properties, so the spoof
 * case below can never arrive through a store, and a test that went through
 * one would pass with or without the guard.
 */
import { describe, expect, it } from 'vitest'
import { storedBytesSchema } from './idb-tx.js'

describe('storedBytesSchema', () => {
  it('copies a genuine Uint8Array so downstream code gets an array of this realm', () => {
    const original = new Uint8Array([1, 2])
    const parsed = storedBytesSchema.parse(original)
    expect(parsed).toEqual(original)
    expect(parsed).not.toBe(original)
  })

  it('rejects a plain object that merely wears the Uint8Array tag', () => {
    expect(storedBytesSchema.safeParse({ [Symbol.toStringTag]: 'Uint8Array' }).success).toBe(false)
  })
})

// @vitest-environment node
/**
 * The stored-bytes predicate, pinned directly: the conformance suite can
 * only reach it with values a real structured clone produces, and a clone
 * DROPS symbol-keyed properties — so the spoof case below can never arrive
 * through the store, and a test that went through it would pass with or
 * without the guard.
 */
import { describe, expect, it } from 'vitest'
import { isStoredUint8Array } from './idb-blob-store.js'

describe('isStoredUint8Array', () => {
  it('accepts a genuine Uint8Array', () => {
    expect(isStoredUint8Array(new Uint8Array([1, 2]))).toBe(true)
  })

  it('rejects a plain object that merely wears the Uint8Array tag', () => {
    // `Object.prototype.toString` honours Symbol.toStringTag on ordinary
    // objects, so the tag check alone accepts this — and `new Uint8Array`
    // over it silently yields empty bytes instead of a miss.
    expect(isStoredUint8Array({ [Symbol.toStringTag]: 'Uint8Array' })).toBe(false)
  })

  it('rejects other ArrayBuffer views', () => {
    expect(isStoredUint8Array(new DataView(new ArrayBuffer(2)))).toBe(false)
    expect(isStoredUint8Array(new Int8Array(2))).toBe(false)
  })
})

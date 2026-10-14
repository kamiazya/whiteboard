// @vitest-environment node
/**
 * The bytes a record read back out of IndexedDB must parse through is pinned
 * directly: a structured clone DROPS symbol-keyed properties, so the spoof
 * case below can never arrive through a store, and a test that went through
 * one would pass with or without the guard.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { request, storedBytesSchema } from './idb-tx.js'

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

describe('request', () => {
  it('answers a stored value as unknown, so a read must parse what it got', () => {
    expectTypeOf(request<any>).returns.toEqualTypeOf<Promise<unknown>>()
    expectTypeOf(request<any[]>).returns.toEqualTypeOf<Promise<unknown[]>>()
  })

  it('keeps the type of a request the DOM types precisely', () => {
    expectTypeOf(request<IDBValidKey>).returns.toEqualTypeOf<Promise<IDBValidKey>>()
    expectTypeOf(request<number>).returns.toEqualTypeOf<Promise<number>>()
    expectTypeOf(request<IDBValidKey[]>).returns.toEqualTypeOf<Promise<IDBValidKey[]>>()
  })
})

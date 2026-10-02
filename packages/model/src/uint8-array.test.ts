import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { isUint8ArrayAnyRealm, uint8ArrayAnyRealmSchema } from './uint8-array.js'

describe('isUint8ArrayAnyRealm', () => {
  it('accepts a Uint8Array of this realm, empty or not', () => {
    expect(isUint8ArrayAnyRealm(new Uint8Array([1, 2]))).toBe(true)
    expect(isUint8ArrayAnyRealm(new Uint8Array(0))).toBe(true)
  })

  it('accepts a Uint8Array minted by another realm, which instanceof refuses', () => {
    const foreign: unknown = runInNewContext('new Uint8Array(3)')
    expect(foreign instanceof Uint8Array).toBe(false)
    expect(isUint8ArrayAnyRealm(foreign)).toBe(true)
  })

  it('rejects a plain object that merely wears the Uint8Array tag', () => {
    // Object.prototype.toString honours Symbol.toStringTag on ordinary
    // objects, so the tag alone accepts this and `new Uint8Array(spoof)`
    // then yields empty bytes instead of a refusal.
    expect(isUint8ArrayAnyRealm({ [Symbol.toStringTag]: 'Uint8Array' })).toBe(false)
  })

  it('rejects other views and non-views', () => {
    expect(isUint8ArrayAnyRealm(new DataView(new ArrayBuffer(2)))).toBe(false)
    expect(isUint8ArrayAnyRealm(new Int8Array(2))).toBe(false)
    expect(isUint8ArrayAnyRealm(new ArrayBuffer(2))).toBe(false)
    expect(isUint8ArrayAnyRealm([1, 2])).toBe(false)
    expect(isUint8ArrayAnyRealm(null)).toBe(false)
    expect(isUint8ArrayAnyRealm(undefined)).toBe(false)
  })
})

describe('uint8ArrayAnyRealmSchema', () => {
  it('parses the same values the predicate accepts and hands the value through', () => {
    const bytes = new Uint8Array([4, 5])
    expect(uint8ArrayAnyRealmSchema.parse(bytes)).toBe(bytes)
    const foreign: unknown = runInNewContext('new Uint8Array(2)')
    expect(uint8ArrayAnyRealmSchema.safeParse(foreign).success).toBe(true)
  })

  it('refuses a spoofed object', () => {
    expect(uint8ArrayAnyRealmSchema.safeParse({ [Symbol.toStringTag]: 'Uint8Array' }).success).toBe(
      false,
    )
  })
})

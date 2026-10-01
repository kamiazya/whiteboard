import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ownValue, readScopedStorage, writeScopedStorage } from './scoped-storage.js'

const KEY = 'whiteboard:scoped-storage-test:v1'
const schema = z.record(z.string(), z.array(z.string()).catch([]))

afterEach(() => {
  // Restored first: the clear below would otherwise go through the throwing getter.
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('scoped storage (localStorage record under a schema)', () => {
  it('reads back what was written', () => {
    writeScopedStorage(KEY, { space: ['a'] })
    expect(readScopedStorage(KEY, schema)).toEqual({ space: ['a'] })
  })

  it('answers empty for an absent key, a non-JSON payload, and a payload the schema refuses', () => {
    expect(readScopedStorage(KEY, schema)).toEqual({})
    localStorage.setItem(KEY, '{not json')
    expect(readScopedStorage(KEY, schema)).toEqual({})
    localStorage.setItem(KEY, '[1,2]')
    expect(readScopedStorage(KEY, schema)).toEqual({})
  })

  // A browser told to block storage raises on the `localStorage` property
  // itself, before any method is called.
  it('neither reads nor writes through a localStorage whose property access throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(readScopedStorage(KEY, schema)).toEqual({})
    expect(() => writeScopedStorage(KEY, { space: ['a'] })).not.toThrow()
  })

  it('does not throw when the value cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => writeScopedStorage(KEY, cyclic)).not.toThrow()
  })
})

describe('ownValue', () => {
  it.each([
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
  ])('answers undefined for the inherited member %s', (key) => {
    expect(ownValue({ space: 1 }, key)).toBeUndefined()
  })

  it('answers an own value, including a falsy one', () => {
    expect(ownValue({ a: 0 }, 'a')).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import {
  coreFacetsSchema,
  extensionFacetsSchema,
  facetsRawSchema,
  RESERVED_ROOT_KEYS,
  storedCoreFacetsSchema,
} from './facets.js'

describe('coreFacetsSchema', () => {
  it('accepts the minimal shape with only type', () => {
    expect(coreFacetsSchema.safeParse({ type: 'note' }).success).toBe(true)
  })

  it('accepts the full shape with title, tags, and view', () => {
    const result = coreFacetsSchema.safeParse({
      type: 'note',
      title: 'My note',
      tags: ['a', 'b'],
      view: 'kanban/1',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a missing type', () => {
    expect(coreFacetsSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an empty type', () => {
    expect(coreFacetsSchema.safeParse({ type: '' }).success).toBe(false)
  })

  it('rejects tags that are not an array of strings', () => {
    expect(coreFacetsSchema.safeParse({ type: 'note', tags: 'a' }).success).toBe(false)
    expect(coreFacetsSchema.safeParse({ type: 'note', tags: [1] }).success).toBe(false)
  })
})

describe('extensionFacetsSchema', () => {
  it('accepts a well-formed {domain}/{version} key and preserves the payload verbatim', () => {
    const payload = { kanban: { columns: ['todo', 'done'] } }
    const result = extensionFacetsSchema.safeParse({ 'kanban/1': payload.kanban })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data['kanban/1']).toEqual(payload.kanban)
    }
  })

  it.each([
    'kanban',
    'kanban/',
    'Kanban/1',
    'kanban/v1',
    '/1',
    'kanban//1',
  ])('rejects (not silently drops) a malformed key %s', (badKey) => {
    const result = extensionFacetsSchema.safeParse({ [badKey]: {} })
    expect(result.success).toBe(false)
  })

  it('accepts an empty record', () => {
    expect(extensionFacetsSchema.safeParse({}).success).toBe(true)
  })
})

describe('facetsRawSchema', () => {
  it('preserves arbitrary non-reserved root keys verbatim', () => {
    const result = facetsRawSchema.safeParse({ someFutureKey: { nested: 1 } })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.someFutureKey).toEqual({ nested: 1 })
    }
  })

  it.each(RESERVED_ROOT_KEYS)('rejects the reserved root key %s', (reservedKey) => {
    const result = facetsRawSchema.safeParse({ [reservedKey]: 'anything' })
    expect(result.success).toBe(false)
  })

  it('accepts an empty record', () => {
    expect(facetsRawSchema.safeParse({}).success).toBe(true)
  })

  // Found by src/properties.test.ts's preservation property. `__proto__` is
  // the one key the "preserves arbitrary non-reserved root keys" rule cannot
  // hold for: Zod deliberately skips it when building the parsed object, so
  // it is neither an own key nor written to the prototype.
  //
  // Keeping that skip is what this pins. Native object spread would carry
  // `__proto__` through as an ordinary own property (spread creates data
  // properties and never invokes the setter), but `Object.assign` and a
  // hand-written `for (k of keys) out[k] = ...` merge both DO invoke it and
  // pollute the target's prototype. A parser that preserved the key would
  // hand every such consumer a loaded payload.
  it('skips a __proto__ key instead of carrying it (parse must not pollute)', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "keep": 1}')
    const result = facetsRawSchema.safeParse(hostile)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.hasOwn(result.data, '__proto__')).toBe(false)
      expect(result.data.keep).toBe(1)
      // The prototype chain is untouched: nothing leaked onto Object.prototype.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype)
      // The point of the skip, stated as behaviour rather than prose: the
      // parsed value is safe to merge through the sink that WOULD pollute.
      const merged = Object.assign({}, result.data)
      expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    }
  })
})

describe('storedCoreFacetsSchema', () => {
  it('accepts the minimal shape with only type', () => {
    expect(storedCoreFacetsSchema.safeParse({ type: 'note' }).success).toBe(true)
  })

  it('accepts core facets plus facetsRaw', () => {
    const result = storedCoreFacetsSchema.safeParse({
      type: 'note',
      title: 'My note',
      tags: ['a', 'b'],
      view: 'kanban/1',
      facetsRaw: { someFutureKey: 'value' },
    })
    expect(result.success).toBe(true)
  })

  it('rejects a missing type', () => {
    expect(storedCoreFacetsSchema.safeParse({ title: 'No type' }).success).toBe(false)
  })

  it('rejects facetsRaw containing a reserved root key', () => {
    const result = storedCoreFacetsSchema.safeParse({ type: 'note', facetsRaw: { type: 'x' } })
    expect(result.success).toBe(false)
  })
})

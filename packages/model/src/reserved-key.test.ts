import { describe, expect, it } from 'vitest'
import { holdsReservedKey } from './reserved-key.js'

describe('holdsReservedKey', () => {
  it.each([
    ['an own key at the root', JSON.parse('{"__proto__":{"a":1}}')],
    ['an own key nested in a mapping', JSON.parse('{"x":{"__proto__":{"a":1}}}')],
    ['an own key inside a list item', JSON.parse('{"x":[{"__proto__":{"a":1}}]}')],
    ['an own key whose value is null', JSON.parse('{"x":{"__proto__":null}}')],
    ['an own key whose value is a scalar', JSON.parse('{"x":{"__proto__":1}}')],
    ['a prototype an assignment replaced', { x: Object.setPrototypeOf({}, { a: 1 }) }],
    [
      'a replaced prototype naming a constructor',
      { x: Object.setPrototypeOf({}, { constructor: { prototype: null } }) },
    ],
  ])('answers true for %s', (_label, value) => {
    expect(holdsReservedKey(value)).toBe(true)
  })

  it.each([
    ['a plain record', { a: { b: [1, 'two', null] } }],
    ['a prototype-less record', Object.assign(Object.create(null), { a: 1 })],
    ['a scalar', 'proto'],
    ['class instances', { set: new Set([1]), bytes: new Uint8Array([1]), at: new Date(0) }],
    ['a value naming the key as a string', { key: '__proto__', list: ['__proto__'] }],
  ])('answers false for %s', (_label, value) => {
    expect(holdsReservedKey(value)).toBe(false)
  })

  it('ends on a cyclic value', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(holdsReservedKey(cyclic)).toBe(false)
  })
})

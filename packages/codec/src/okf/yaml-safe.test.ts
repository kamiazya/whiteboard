import { describe, expect, it } from 'vitest'
import { yamlSafeValueSchema } from './yaml-safe.js'

describe('yamlSafeValueSchema', () => {
  it('accepts plain JSON-shaped values', () => {
    const result = yamlSafeValueSchema.safeParse({ a: [1, 'two', true, null], b: { c: 3 } })
    expect(result.success).toBe(true)
  })

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['bigint', 1n],
    ['function', () => {}],
    ['symbol', Symbol('x')],
  ])('rejects %s', (_label, value) => {
    const result = yamlSafeValueSchema.safeParse(value)
    expect(result.success).toBe(false)
  })

  it.each([
    ['a Set', new Set(['a'])],
    ['a Map', new Map([['a', 1]])],
    ['bytes', new Uint8Array([1, 2])],
    ['a Date', new Date(0)],
    ['a class instance', new (class Box {})()],
  ])('rejects %s, which a JSON-shaped store would flatten or round', (_label, value) => {
    expect(yamlSafeValueSchema.safeParse({ a: [value] }).success).toBe(false)
  })

  it('accepts a prototype-less record, the shape the parser builds its bucket with', () => {
    expect(
      yamlSafeValueSchema.safeParse(Object.assign(Object.create(null), { a: 1 })).success,
    ).toBe(true)
  })

  it('accepts the largest safe integer and a fraction', () => {
    expect(
      yamlSafeValueSchema.safeParse([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1.5])
        .success,
    ).toBe(true)
  })

  it('rejects a cyclic object without stack overflow', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic

    const result = yamlSafeValueSchema.safeParse(cyclic)
    expect(result.success).toBe(false)
  })

  it('rejects undefined/NaN nested inside an array or object', () => {
    expect(yamlSafeValueSchema.safeParse([1, undefined]).success).toBe(false)
    expect(yamlSafeValueSchema.safeParse({ a: Number.NaN }).success).toBe(false)
  })
})

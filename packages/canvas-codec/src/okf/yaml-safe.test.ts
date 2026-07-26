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

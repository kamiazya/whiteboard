import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as model from './index.js'
import { boundedStringsInExports, refusesAstralOverflow } from './test-utils/utf16-bound.js'
import { utf16Max } from './utf16-max.js'

describe('every bounded string the model exports counts UTF-16 units', () => {
  const bounded = boundedStringsInExports(model)

  it('reaches the bounded strings the model declares', () => {
    expect(bounded.length).toBeGreaterThan(20)
    expect(new Set(bounded.map((found) => found.name)).size).toBeGreaterThan(15)
  })

  it.each(bounded)('$name: a limit of $max refuses an astral run over it', (found) => {
    expect(refusesAstralOverflow(found)).toBe(true)
  })
})

describe('utf16Max', () => {
  const schema = utf16Max(z.string(), 4, 'too long')

  it('keeps maxLength in the emitted JSON Schema', () => {
    expect(z.toJSONSchema(schema)).toMatchObject({ type: 'string', maxLength: 4 })
  })

  it('reports an overlong string once, in the caller words', () => {
    const verdict = schema.safeParse('x'.repeat(5))
    expect(verdict.success ? [] : verdict.error.issues.map((issue) => issue.message)).toEqual([
      'too long',
    ])
  })

  it('leaves a missing value to the type check', () => {
    const verdict = z.object({ name: schema }).safeParse({})
    expect(verdict.success ? [] : verdict.error.issues.map((issue) => issue.code)).toEqual([
      'invalid_type',
    ])
  })

  it('admits what fits in code units and refuses what fits only in code points', () => {
    expect(schema.safeParse('😀😀').success).toBe(true)
    const verdict = schema.safeParse('😀😀😀')
    expect(verdict.success ? [] : verdict.error.issues.map((issue) => issue.message)).toEqual([
      'too long',
    ])
  })
})

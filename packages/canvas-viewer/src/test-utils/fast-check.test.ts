import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from './fast-check.js'

describe('fast-check test-utils wrapper', () => {
  fcTest.prop([fc.integer()], withDefaults())(
    'round-trips an integer through String/Number',
    (n) => {
      expect(Number(String(n))).toBe(n)
    },
  )

  it('withDefaults sets numRuns to 200 and lets callers override it', () => {
    expect(withDefaults()).toEqual({ numRuns: 200 })
    expect(withDefaults({ numRuns: 10 })).toEqual({ numRuns: 10 })
  })
})

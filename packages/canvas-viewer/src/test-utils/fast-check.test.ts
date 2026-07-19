import { describe, expect, it } from 'vitest'
import { withDefaults } from './fast-check.js'

describe('withDefaults', () => {
  it('defaults numRuns to 200 when no override is given', () => {
    expect(withDefaults().numRuns).toBe(200)
  })

  it('lets an override replace numRuns', () => {
    expect(withDefaults({ numRuns: 10 }).numRuns).toBe(10)
  })

  // Regression for withDefaults being pinned to `fc.Parameters<never>`: that
  // signature made `examples` uninhabitable (only `never[]` was assignable),
  // so a caller could not pass a typed `examples` override for its own
  // arbitrary tuple. The explicit type argument below only typechecks
  // because withDefaults is generic over T.
  it('preserves a typed examples override for the caller-specified tuple', () => {
    const params = withDefaults<[number, string]>({ examples: [[1, 'a']] })
    expect(params.numRuns).toBe(200)
    expect(params.examples).toEqual([[1, 'a']])
  })
})

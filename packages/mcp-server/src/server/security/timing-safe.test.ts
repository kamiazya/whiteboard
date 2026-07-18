import { describe, expect, it } from 'vitest'
import { timingSafeEqualStrings } from './timing-safe.js'

describe('timingSafeEqualStrings', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualStrings('secret-token', 'secret-token')).toBe(true)
  })

  it('returns false for same-length different strings', () => {
    expect(timingSafeEqualStrings('secret-token', 'wrongg-token')).toBe(false)
  })

  it('returns false for different-length strings without throwing', () => {
    expect(() => timingSafeEqualStrings('short', 'a-much-longer-string')).not.toThrow()
    expect(timingSafeEqualStrings('short', 'a-much-longer-string')).toBe(false)
  })

  it('returns false comparing an empty string against a non-empty one', () => {
    expect(timingSafeEqualStrings('', 'non-empty')).toBe(false)
  })

  it('returns true for two empty strings', () => {
    expect(timingSafeEqualStrings('', '')).toBe(true)
  })
})

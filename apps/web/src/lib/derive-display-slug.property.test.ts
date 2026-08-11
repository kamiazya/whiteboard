import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { deriveDisplaySlug } from './derive-display-slug.js'

// The charset property matches the daemon's validateSlug rule, so a future promotion of display
// slugs to real slugs never has to re-derive.
const SLUG_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

describe('deriveDisplaySlug properties', () => {
  fcTest.prop(
    [
      fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
      fc.array(fc.string(), { maxLength: 8 }),
    ],
    withDefaults(),
  )('always yields a valid slug shape that is not already taken', (name, existing) => {
    const out = deriveDisplaySlug(name, existing)
    expect(out).toMatch(SLUG_SHAPE)
    expect(existing).not.toContain(out)
  })

  fcTest.prop(
    [
      fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
      fc.array(fc.string(), { maxLength: 8 }),
    ],
    withDefaults(),
  )('is deterministic', (name, existing) => {
    expect(deriveDisplaySlug(name, existing)).toBe(deriveDisplaySlug(name, existing))
  })
})

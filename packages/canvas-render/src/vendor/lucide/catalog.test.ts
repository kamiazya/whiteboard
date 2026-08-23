// The badge picker offers exactly what the renderer can draw, so the name
// set is a published surface — not something a UI re-lists by hand.
import { describe, expect, it } from 'vitest'
import { BUILT_IN_ICON_NAMES } from '../../index.js'
import { LUCIDE_ICONS } from './icons.js'

describe('BUILT_IN_ICON_NAMES', () => {
  it('names exactly the vendored set, sorted', () => {
    expect([...BUILT_IN_ICON_NAMES]).toEqual(Object.keys(LUCIDE_ICONS).sort())
  })

  it('is non-empty and every name resolves to geometry', () => {
    expect(BUILT_IN_ICON_NAMES.length).toBeGreaterThan(0)
    for (const name of BUILT_IN_ICON_NAMES) {
      expect(Array.isArray(LUCIDE_ICONS[name])).toBe(true)
    }
  })
})

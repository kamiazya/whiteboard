import { describe, expect, it } from 'vitest'
import { iconGeometry, LUCIDE_ICONS } from './icons.js'

// A symbol's icon name is document text validated for non-emptiness only, so
// a name every plain object inherits must read as "no such icon" rather than
// handing a caller a function or the prototype to iterate.
const INHERITED_NAMES = [
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
]

describe('iconGeometry', () => {
  it('answers the vendored geometry for a name the set carries', () => {
    expect(iconGeometry('database')).toBe(LUCIDE_ICONS.database)
  })

  it('answers undefined for a name the set does not carry', () => {
    expect(iconGeometry('no-such-icon')).toBeUndefined()
  })

  it.each(INHERITED_NAMES)('answers undefined for the inherited name %s', (name) => {
    expect(iconGeometry(name)).toBeUndefined()
  })
})

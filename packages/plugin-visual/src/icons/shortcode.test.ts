/** The typing half of the ICON vocabulary, and the sibling of `emoji/shortcode.test.ts`. */
import { describe, expect, it } from 'vitest'
import { BUILT_IN_ICON_NAMES } from './icons.js'
import { searchIconShortcodes } from './shortcode.js'

describe('what a typed query could mean', () => {
  it('finds a name with or without the prefix, so the prefix need not be known', () => {
    expect(searchIconShortcodes('st')).toEqual(['star'])
    expect(searchIconShortcodes('icon-st')).toEqual(['star'])
    expect(searchIconShortcodes('icon-')).toEqual([...BUILT_IN_ICON_NAMES])
  })

  it('puts an exact name first, then a prefix, then anything containing it', () => {
    // `file` is exact; `link` merely contains an `i`, and is not offered for
    // a query the exact one answers.
    expect(searchIconShortcodes('file')[0]).toBe('file')
    expect(searchIconShortcodes('l')).toEqual(['layers', 'link', 'lock', 'file'])
  })

  it('answers nothing for a query no vendored name could be', () => {
    expect(searchIconShortcodes('zzz')).toEqual([])
  })
})

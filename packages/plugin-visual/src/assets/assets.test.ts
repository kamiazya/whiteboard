// The asset JSON files are the single source of the bundled values (the Rust
// core embeds the same bytes), so what is held here is the file itself: each
// entry is already what its schema parses it to, the sets that share a
// registry cannot shadow one another, and the importer refuses what it cannot
// vouch for.
import {
  iconAssetSchema,
  stencilAssetSchema,
  themeTokensSchema,
} from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { assetTable } from '../asset-table.js'
import { visualPlugin } from '../data.js'
import { BUILT_IN_ICON_NAMES } from '../icons/icons.js'
import glyphs from './icons-glyphs.json' with { type: 'json' }
import lucide from './icons-lucide.json' with { type: 'json' }
import stencils from './stencils.json' with { type: 'json' }
import themes from './themes.json' with { type: 'json' }

const TABLES = [
  ['theme', themes, themeTokensSchema],
  ['stencil', stencils, stencilAssetSchema],
  ['lucide icon', lucide, iconAssetSchema],
  ['glyph icon', glyphs, iconAssetSchema],
] as const

describe('the bundled asset files', () => {
  it.each(TABLES)('every %s entry parses to exactly itself', (_, table, schema) => {
    const entries = Object.entries(table)
    expect(entries.length).toBeGreaterThan(1)
    for (const [name, entry] of entries) {
      expect(schema.parse(entry), name).toEqual(entry)
    }
  })

  it('keeps the vendored icons sorted, which BUILT_IN_ICON_NAMES publishes as is', () => {
    const names = Object.keys(lucide)
    expect(names.length).toBeGreaterThan(5)
    expect(names).toEqual([...names].sort())
    expect([...BUILT_IN_ICON_NAMES]).toEqual(names)
  })

  it('names no glyph the vendored set already has, so neither shadows the other', () => {
    const vendored = new Set(Object.keys(lucide))
    expect(Object.keys(glyphs).filter((name) => vendored.has(name))).toEqual([])
  })

  it('registers the vendored icons, then the glyphs, in file order', () => {
    expect(Object.keys(visualPlugin.assets?.icons ?? {})).toEqual([
      ...Object.keys(lucide),
      ...Object.keys(glyphs),
    ])
  })
})

describe('assetTable', () => {
  it('hands back the entries it was given, not copies', () => {
    const table = assetTable('icon', lucide, iconAssetSchema)
    expect(table.database).toBe(lucide.database)
  })

  it('refuses an entry its schema refuses, naming it', () => {
    const broken = { ...lucide, empty: { geometry: [] } }
    expect(() => assetTable('icon', broken, iconAssetSchema)).toThrow(/icon asset "empty"/)
  })
})

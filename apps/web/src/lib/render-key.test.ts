import { describe, expect, it } from 'vitest'
import {
  isMemoisableKey,
  outlineKeyOf,
  RENDERER_BUILD_ID,
  renderKeyOf,
  renderKeyPath,
  renderKeySchema,
} from './render-key.js'

const spatial = { documentId: 'doc-1', kind: 'spatial' as const, updatedAt: '2026-09-03T00:00:00Z' }
const markdown = {
  documentId: 'doc-2',
  kind: 'markdown' as const,
  updatedAt: '2026-09-03T00:00:00Z',
}

// The daemon contract declares `id` opaque and deliberately not
// pattern-bound, and `updatedAt` is a plain string beside it. So path syntax
// inside either is not excluded by anything upstream, and the path is both
// this cache's map key and the address the OPFS store will use.
describe('renderKeyPath — every component unambiguous', () => {
  const md = (documentId: string, updatedAt: string) =>
    renderKeyOf({ documentId, kind: 'markdown' as const, updatedAt }, 'light')

  it('keeps two documents apart when a separator moves between id and version', () => {
    // Unencoded, both of these join to `<build>/markdown/a/b/c.svg` — two
    // different documents, one entry, and the second row shows the first
    // one's picture.
    expect(renderKeyPath(md('a', 'b/c'))).not.toBe(renderKeyPath(md('a/b', 'c')))
  })

  it('keeps a document whose id contains a separator apart from its neighbour', () => {
    expect(renderKeyPath(md('x/y', 'v'))).not.toBe(renderKeyPath(md('x', 'y/v')))
  })

  // `.` and `..` are ordinary strings to a Map and directory traversal to a
  // filesystem. The encoding has to make them impossible as whole segments
  // before the OPFS store exists, not after.
  it('never emits a dot or dot-dot segment', () => {
    for (const id of ['.', '..', 'a/../b']) {
      const segments = renderKeyPath(md(id, '..')).split('/')
      expect(segments).not.toContain('.')
      expect(segments).not.toContain('..')
    }
  })

  it('is still one path per key — the same key twice is the same path', () => {
    expect(renderKeyPath(md('a/b', 'c'))).toBe(renderKeyPath(md('a/b', 'c')))
  })
})

// A key with no version cannot notice that its document changed, so a
// completed render must not be remembered under it. The in-flight join is
// still safe there — two panes asking at the same instant are asking about
// the same bytes — and that distinction is the whole point of this flag.
// The broker holds ONE map, so two families asking about the same document
// must not name the same entry. Before the pipeline axis they did: both keys
// were `<build>/<kind>/<doc>/<version>.svg`, so a tree row's outline and a
// list row's SVG collided — and whichever arrived first answered the other,
// with a type the caller had no reason to check. The `.svg` extension was
// also a lie for half of them.
describe('renderKeyPath — the pipeline is part of the identity', () => {
  const subject = { documentId: 'd', kind: 'spatial' as const, updatedAt: 'v1' }

  it('keeps an outline of a document apart from its SVG', () => {
    expect(renderKeyPath(outlineKeyOf(subject))).not.toBe(
      renderKeyPath(renderKeyOf(subject, 'light')),
    )
  })

  it('names each family in the path, so a stored entry says what it holds', () => {
    expect(renderKeyPath(renderKeyOf(subject, 'light')).endsWith('.svg')).toBe(true)
    expect(renderKeyPath(outlineKeyOf(subject)).endsWith('.svg')).toBe(false)
  })

  it('defaults to the svg family, which every existing caller is', () => {
    expect(renderKeyOf(subject, 'light').pipeline).toBe('svg')
  })

  // An outline's colours are resolved from the LIGHT palette for both kinds,
  // so the theme is not an axis of it at all. Carrying one would double the
  // entries for nothing and, worse, make a theme toggle redraw every tree
  // row icon to produce identical rectangles.
  it('drops the theme axis for an outline, whose colours do not depend on it', () => {
    expect(outlineKeyOf(subject).theme).toBeNull()
    expect(renderKeyPath(outlineKeyOf(subject))).toBe(renderKeyPath(outlineKeyOf(subject)))
  })

  it('keeps the theme axis for a spatial SVG, whose palette is baked in', () => {
    expect(renderKeyOf(subject, 'dark').theme).toBe('dark')
  })
})

describe('isMemoisableKey', () => {
  it('refuses a key with no version', () => {
    expect(isMemoisableKey(renderKeyOf({ documentId: 'd', kind: 'spatial' }, 'light'))).toBe(false)
  })

  it('accepts a key that carries one', () => {
    expect(isMemoisableKey(renderKeyOf(spatial, 'light'))).toBe(true)
  })
})

describe('renderKeyOf', () => {
  it('carries the theme for a spatial document, whose palette is baked into the SVG', () => {
    expect(renderKeyOf(spatial, 'light').theme).toBe('light')
    expect(renderKeyOf(spatial, 'dark').theme).toBe('dark')
  })

  // The whole reason a markdown row survives a theme toggle: its ink comes
  // from CSS, so the same bytes serve both themes and the axis is absent
  // rather than set to something.
  it('omits the theme for a markdown document, whose ink comes from CSS', () => {
    expect(renderKeyOf(markdown, 'light').theme).toBeNull()
    expect(renderKeyPath(renderKeyOf(markdown, 'light'))).toBe(
      renderKeyPath(renderKeyOf(markdown, 'dark')),
    )
  })

  it('separates two themes of the SAME spatial document', () => {
    expect(renderKeyPath(renderKeyOf(spatial, 'light'))).not.toBe(
      renderKeyPath(renderKeyOf(spatial, 'dark')),
    )
  })

  it('changes when the document does', () => {
    const later = { ...spatial, updatedAt: '2026-09-03T01:00:00Z' }
    expect(renderKeyPath(renderKeyOf(later, 'light'))).not.toBe(
      renderKeyPath(renderKeyOf(spatial, 'light')),
    )
  })

  // A keeper that does not stamp updatedAt still gets a key; what it loses is
  // the ability to notice a change, which is a persistence concern and not a
  // reason to render the same document twice inside one sitting.
  it('accepts a document with no version stamp', () => {
    const key = renderKeyOf({ documentId: 'doc-3', kind: 'spatial' }, 'light')
    expect(key.version).toBeNull()
    expect(renderKeySchema.safeParse(key).success).toBe(true)
  })

  it('leads the path with the build id, so retiring a build is one directory', () => {
    // The first segment, decoded — the encoding is reversible on purpose, so
    // a sweep can still recognise which build a directory belongs to.
    const [first] = renderKeyPath(renderKeyOf(spatial, 'light')).split('/')
    expect(decodeURIComponent((first ?? '').replace(/^~/, ''))).toBe(RENDERER_BUILD_ID)
  })

  it('is a valid key by its own schema', () => {
    expect(renderKeySchema.safeParse(renderKeyOf(spatial, 'dark')).success).toBe(true)
  })
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  isMemoisableKey,
  outlineKeyOf,
  RENDERER_BUILD_ID,
  renderKeyOf,
  renderKeyPath,
  renderKeySchema,
  tagLibraryKey,
} from './render-key.js'

/** A realm holding no theme face — what every case below is keyed in unless it says otherwise. */
const NO_FACES = ''

/** A workspace whose tag library declares no colour. */
const NO_LIBRARY = ''

const spatial = { documentId: 'doc-1', kind: 'spatial' as const, state: '2026-09-03T00:00:00Z' }
const markdown = {
  documentId: 'doc-2',
  kind: 'markdown' as const,
  state: '2026-09-03T00:00:00Z',
}

// The daemon contract declares `id` opaque and deliberately not
// pattern-bound, and the content state is a plain string beside it. So path syntax
// inside either is not excluded by anything upstream, and the path is both
// this cache's map key and the address the OPFS store will use.
describe('renderKeyPath — every component unambiguous', () => {
  const md = (documentId: string, state: string) =>
    renderKeyOf({ documentId, kind: 'markdown' as const, state }, 'light', NO_FACES, NO_LIBRARY)

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
  const subject = { documentId: 'd', kind: 'spatial' as const, state: 'v1' }

  it('keeps an outline of a document apart from its SVG', () => {
    expect(renderKeyPath(outlineKeyOf(subject))).not.toBe(
      renderKeyPath(renderKeyOf(subject, 'light', NO_FACES, NO_LIBRARY)),
    )
  })

  // The family is named by a SEGMENT, not by the extension. Both are stored
  // as JSON because what a caller needs back is the whole worker reply — an
  // SVG plus the bounds it is scaled to, or an outline's rectangles — so an
  // entry named `.svg` would be describing one field of the file it holds.
  it('names each family in the path, so a stored entry says what it holds', () => {
    expect(renderKeyPath(renderKeyOf(subject, 'light', NO_FACES, NO_LIBRARY))).toContain('/svg/')
    expect(renderKeyPath(outlineKeyOf(subject))).toContain('/outline/')
    expect(
      renderKeyPath(renderKeyOf(subject, 'light', NO_FACES, NO_LIBRARY)).endsWith('.json'),
    ).toBe(true)
    expect(renderKeyPath(outlineKeyOf(subject)).endsWith('.json')).toBe(true)
  })

  it('defaults to the svg family, which every existing caller is', () => {
    expect(renderKeyOf(subject, 'light', NO_FACES, NO_LIBRARY).pipeline).toBe('svg')
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
    expect(renderKeyOf(subject, 'dark', NO_FACES, NO_LIBRARY).theme).toBe('dark')
  })

  // A theme's family is measurable only once this tab holds a face for it,
  // and a list surface asks for that face only after it has drawn the board
  // once. So the picture and the face set are one identity: without this
  // axis the second ask is answered by the first picture, in the bundled
  // family, for as long as the entry lives — which on disk is past the tab.
  it('keeps the faces this realm could measure as an axis of a spatial SVG', () => {
    expect(renderKeyOf(subject, 'light', 'Yomogi', NO_LIBRARY).fonts).toBe('Yomogi')
    expect(renderKeyPath(renderKeyOf(subject, 'light', 'Yomogi', NO_LIBRARY))).not.toBe(
      renderKeyPath(renderKeyOf(subject, 'light', NO_FACES, NO_LIBRARY)),
    )
  })

  // Markdown is measured in the bundled family whatever a theme names, so
  // its entry survives a face landing — the same asymmetry the theme axis
  // has, for the same reason.
  it('drops the font axis for markdown, and for an outline of either kind', () => {
    expect(renderKeyOf(markdown, 'light', 'Yomogi', NO_LIBRARY).fonts).toBeNull()
    expect(renderKeyPath(renderKeyOf(markdown, 'light', 'Yomogi', NO_LIBRARY))).toBe(
      renderKeyPath(renderKeyOf(markdown, 'light', NO_FACES, NO_LIBRARY)),
    )
    expect(outlineKeyOf(subject).fonts).toBeNull()
  })

  // A family name may hold the separator this path is cut on, so it is
  // encoded like every other opaque value — two realms must not join to one
  // entry because one holds `a,b` and the other `a` and `b`.
  it('keeps two face sets apart however their names are punctuated', () => {
    expect(renderKeyPath(renderKeyOf(subject, 'light', 'a/b', NO_LIBRARY))).not.toBe(
      renderKeyPath(renderKeyOf(subject, 'light', 'a', NO_LIBRARY)),
    )
  })
})

describe('isMemoisableKey', () => {
  it('refuses a key with no version', () => {
    expect(
      isMemoisableKey(
        renderKeyOf({ documentId: 'd', kind: 'spatial' }, 'light', NO_FACES, NO_LIBRARY),
      ),
    ).toBe(false)
  })

  it('accepts a key that carries one', () => {
    expect(isMemoisableKey(renderKeyOf(spatial, 'light', NO_FACES, NO_LIBRARY))).toBe(true)
  })
})

describe('renderKeyOf', () => {
  it('carries the theme for a spatial document, whose palette is baked into the SVG', () => {
    expect(renderKeyOf(spatial, 'light', NO_FACES, NO_LIBRARY).theme).toBe('light')
    expect(renderKeyOf(spatial, 'dark', NO_FACES, NO_LIBRARY).theme).toBe('dark')
  })

  // The whole reason a markdown row survives a theme toggle: its ink comes
  // from CSS, so the same bytes serve both themes and the axis is absent
  // rather than set to something.
  it('omits the theme for a markdown document, whose ink comes from CSS', () => {
    expect(renderKeyOf(markdown, 'light', NO_FACES, NO_LIBRARY).theme).toBeNull()
    expect(renderKeyPath(renderKeyOf(markdown, 'light', NO_FACES, NO_LIBRARY))).toBe(
      renderKeyPath(renderKeyOf(markdown, 'dark', NO_FACES, NO_LIBRARY)),
    )
  })

  it('separates two themes of the SAME spatial document', () => {
    expect(renderKeyPath(renderKeyOf(spatial, 'light', NO_FACES, NO_LIBRARY))).not.toBe(
      renderKeyPath(renderKeyOf(spatial, 'dark', NO_FACES, NO_LIBRARY)),
    )
  })

  it('changes when the document does', () => {
    const later = { ...spatial, state: '2026-09-03T01:00:00Z' }
    expect(renderKeyPath(renderKeyOf(later, 'light', NO_FACES, NO_LIBRARY))).not.toBe(
      renderKeyPath(renderKeyOf(spatial, 'light', NO_FACES, NO_LIBRARY)),
    )
  })

  // A keeper that reports no content state still gets a key; what it loses is
  // the ability to notice a change, which is a persistence concern and not a
  // reason to render the same document twice inside one sitting.
  it('accepts a document with no version stamp', () => {
    const key = renderKeyOf({ documentId: 'doc-3', kind: 'spatial' }, 'light', NO_FACES, NO_LIBRARY)
    expect(key.version).toBeNull()
    expect(renderKeySchema.safeParse(key).success).toBe(true)
  })

  it('leads the path with the build id, so retiring a build is one directory', () => {
    // The first segment, decoded — the encoding is reversible on purpose, so
    // a sweep can still recognise which build a directory belongs to.
    const [first] = renderKeyPath(renderKeyOf(spatial, 'light', NO_FACES, NO_LIBRARY)).split('/')
    expect(decodeURIComponent((first ?? '').replace(/^~/, ''))).toBe(RENDERER_BUILD_ID)
  })

  it('is a valid key by its own schema', () => {
    expect(
      renderKeySchema.safeParse(renderKeyOf(spatial, 'dark', NO_FACES, NO_LIBRARY)).success,
    ).toBe(true)
  })
})

// A board's uncoloured boxes are drawn in the colour the workspace's tag
// library declares for their tags, so the library is part of what a spatial
// picture IS. Without the axis an edit to the library leaves every cached
// thumbnail — on disk, past the tab — in the colour it no longer declares.
describe('the tag library axis', () => {
  const green = { health: { values: { ok: { color: '4' as const } } } }
  const red = { health: { values: { ok: { color: '1' as const } } } }

  it('keys two libraries that colour a tag differently as two pictures', async () => {
    const a = await tagLibraryKey(green)
    const b = await tagLibraryKey(red)
    expect(a).not.toBe(b)
    expect(renderKeyPath(renderKeyOf(spatial, 'light', NO_FACES, a))).not.toBe(
      renderKeyPath(renderKeyOf(spatial, 'light', NO_FACES, b)),
    )
  })

  it('keys the same library the same, whatever order its declarations arrive in', async () => {
    const two = {
      health: { values: { ok: { color: '4' as const }, failing: { color: '1' as const } } },
      tier: { values: { db: { color: '#336699' as const } } },
    }
    const reordered = {
      tier: { values: { db: { color: '#336699' as const } } },
      health: { values: { failing: { color: '1' as const }, ok: { color: '4' as const } } },
    }
    expect(await tagLibraryKey(reordered)).toBe(await tagLibraryKey(two))
  })

  // Only a declared colour reaches the picture, so a description or an
  // `exclusive` flag changing must not throw away every thumbnail.
  it('ignores what a library declares that no picture draws', async () => {
    const described = {
      health: {
        description: 'is it up',
        exclusive: true,
        values: { ok: { color: '4' as const, description: 'fine' } },
      },
    }
    expect(await tagLibraryKey(described)).toBe(await tagLibraryKey(green))
  })

  it('keys a library that declares no colour as no library at all', async () => {
    expect(await tagLibraryKey({})).toBe(NO_LIBRARY)
    expect(await tagLibraryKey({ health: { values: { ok: {} } } })).toBe(NO_LIBRARY)
  })

  it('stays a bounded path segment however large the library grows', async () => {
    const values = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`value${i}`, { color: '4' as const }]),
    )
    expect((await tagLibraryKey({ many: { values } })).length).toBeLessThanOrEqual(32)
  })

  // Markdown has no boxes to colour, so its picture survives a library edit.
  it('drops the axis for markdown, and for an outline', async () => {
    const key = await tagLibraryKey(green)
    expect(renderKeyOf(markdown, 'light', NO_FACES, key).library).toBeNull()
    expect(renderKeyPath(renderKeyOf(markdown, 'light', NO_FACES, key))).toBe(
      renderKeyPath(renderKeyOf(markdown, 'light', NO_FACES, NO_LIBRARY)),
    )
    expect(outlineKeyOf(spatial).library).toBeNull()
  })

  it('is a valid key by its own schema', async () => {
    const key = renderKeyOf(spatial, 'light', NO_FACES, await tagLibraryKey(green))
    expect(renderKeySchema.safeParse(key).success).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { renderFavicon } from './favicon.js'

// Real browser: canvas 2D is available, so renderFavicon must produce a
// PNG data URL and every visual state must actually differ on pixels.
describe('renderFavicon (real canvas)', () => {
  const rects = [
    { x: 0, y: 0, w: 100, h: 60 },
    { x: 200, y: 120, w: 100, h: 60 },
  ]

  it('renders a PNG data URL', () => {
    const url = renderFavicon({ style: 'dot', status: 'quiet', rects: [] })
    expect(url).toMatch(/^data:image\/png;base64,/)
  })

  it('gives every distinct status a distinct icon (stuck and reconnecting share the amber dot on purpose)', () => {
    const urls = (['quiet', 'unsaved', 'offline'] as const).map((status) =>
      renderFavicon({ style: 'dot', status, rects: [] }),
    )
    expect(new Set(urls).size).toBe(3)
  })

  it('minimap with content differs from the empty-canvas logo fallback', () => {
    const empty = renderFavicon({ style: 'minimap', status: 'quiet', rects: [] })
    const filled = renderFavicon({ style: 'minimap', status: 'quiet', rects })
    expect(filled).not.toBe(empty)
  })

  it('node colors change the minimap pixels', () => {
    const gray = renderFavicon({ style: 'minimap', status: 'quiet', rects })
    const colored = renderFavicon({
      style: 'minimap',
      status: 'quiet',
      rects: rects.map((r) => ({ ...r, color: '#dc2626' })),
    })
    expect(colored).not.toBe(gray)
  })

  it('dot style ignores scene content', () => {
    const a = renderFavicon({ style: 'dot', status: 'quiet', rects: [] })
    const b = renderFavicon({ style: 'dot', status: 'quiet', rects })
    expect(a).toBe(b)
  })
})

// A document's own symbol is the mark, under either style: the style says
// how much of the CONTENT to show, and a symbol is not content — it is what
// this document is called by, so it wins over both the minimap and the logo.
describe('renderFavicon with a document symbol', () => {
  const rects = [
    { x: 0, y: 0, w: 100, h: 60 },
    { x: 200, y: 120, w: 100, h: 60 },
  ]

  it('draws the symbol instead of the logo squiggle', () => {
    const plain = renderFavicon({ style: 'dot', status: 'quiet', rects: [] })
    const withIcon = renderFavicon({
      style: 'dot',
      status: 'quiet',
      rects: [],
      symbol: { kind: 'icon', name: 'star' },
    })
    expect(withIcon).not.toBe(plain)
  })

  it('draws the symbol instead of the minimap, content or not', () => {
    const minimap = renderFavicon({ style: 'minimap', status: 'quiet', rects })
    const symbolled = renderFavicon({
      style: 'minimap',
      status: 'quiet',
      rects,
      symbol: { kind: 'icon', name: 'star' },
    })
    expect(symbolled).not.toBe(minimap)
    // ...and the scene behind it no longer changes the icon: the symbol has
    // replaced what the rects were drawing, rather than being layered over.
    const otherScene = renderFavicon({
      style: 'minimap',
      status: 'quiet',
      rects: [{ x: 0, y: 0, w: 500, h: 20 }],
      symbol: { kind: 'icon', name: 'star' },
    })
    expect(otherScene).toBe(symbolled)
  })

  it('an emoji and an icon are different marks', () => {
    const icon = renderFavicon({
      style: 'dot',
      status: 'quiet',
      rects: [],
      symbol: { kind: 'icon', name: 'star' },
    })
    const emoji = renderFavicon({
      style: 'dot',
      status: 'quiet',
      rects: [],
      symbol: { kind: 'emoji', char: '📌' },
    })
    expect(emoji).not.toBe(icon)
  })

  it('an icon name this build does not carry falls back to what would have been drawn', () => {
    // The schema validates a name for non-emptiness only, so an unknown one
    // reaches here. Every surface degrades the same way — "no symbol" — and
    // for the favicon that means the content it already had, never an empty
    // board.
    const unknown = { kind: 'icon', name: 'no-such-icon' } as const
    expect(renderFavicon({ style: 'dot', status: 'quiet', rects: [], symbol: unknown })).toBe(
      renderFavicon({ style: 'dot', status: 'quiet', rects: [] }),
    )
    expect(renderFavicon({ style: 'minimap', status: 'quiet', rects, symbol: unknown })).toBe(
      renderFavicon({ style: 'minimap', status: 'quiet', rects }),
    )
  })

  it('the status grammar still reads over a symbol', () => {
    // The dot and the offline dashes belong to the board, not to the mark,
    // so replacing the mark must leave them working.
    const symbol = { kind: 'emoji', char: '📌' } as const
    const urls = (['quiet', 'unsaved', 'offline'] as const).map((status) =>
      renderFavicon({ style: 'dot', status, rects: [], symbol }),
    )
    expect(new Set(urls).size).toBe(3)
  })

  it('a document with no symbol renders exactly what it rendered before', () => {
    // The additivity guarantee: passing the field as undefined is the same
    // bytes as not passing it, so nothing changes for the documents that
    // have no symbol — which is all of them today.
    expect(renderFavicon({ style: 'minimap', status: 'quiet', rects, symbol: undefined })).toBe(
      renderFavicon({ style: 'minimap', status: 'quiet', rects }),
    )
  })
})

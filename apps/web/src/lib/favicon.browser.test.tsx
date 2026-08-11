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
    const url = renderFavicon({ style: 'dot', status: 'saved', rects: [] })
    expect(url).toMatch(/^data:image\/png;base64,/)
  })

  it('gives every status a distinct icon', () => {
    const urls = (['saved', 'unsaved', 'syncing', 'offline'] as const).map((status) =>
      renderFavicon({ style: 'dot', status, rects: [] }),
    )
    expect(new Set(urls).size).toBe(4)
  })

  it('minimap with content differs from the empty-canvas logo fallback', () => {
    const empty = renderFavicon({ style: 'minimap', status: 'saved', rects: [] })
    const filled = renderFavicon({ style: 'minimap', status: 'saved', rects })
    expect(filled).not.toBe(empty)
  })

  it('node colors change the minimap pixels', () => {
    const gray = renderFavicon({ style: 'minimap', status: 'saved', rects })
    const colored = renderFavicon({
      style: 'minimap',
      status: 'saved',
      rects: rects.map((r) => ({ ...r, color: '#dc2626' })),
    })
    expect(colored).not.toBe(gray)
  })

  it('dot style ignores scene content', () => {
    const a = renderFavicon({ style: 'dot', status: 'saved', rects: [] })
    const b = renderFavicon({ style: 'dot', status: 'saved', rects })
    expect(a).toBe(b)
  })
})

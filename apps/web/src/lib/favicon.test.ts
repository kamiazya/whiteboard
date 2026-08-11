import { afterEach, describe, expect, it } from 'vitest'
import { applyFavicon, projectRectsToBoard, STATIC_FAVICON_HREF } from './favicon.js'

describe('projectRectsToBoard', () => {
  it('returns no rects for an empty scene (favicon falls back to the logo squiggle)', () => {
    expect(projectRectsToBoard([])).toEqual([])
  })

  it('fits the scene bounding box inside the board with uniform scale', () => {
    const projected = projectRectsToBoard([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 900, y: 0, w: 100, h: 100 },
    ])
    expect(projected).toHaveLength(2)
    for (const r of projected) {
      expect(r.x).toBeGreaterThanOrEqual(4)
      expect(r.y).toBeGreaterThanOrEqual(7)
      expect(r.x + r.w).toBeLessThanOrEqual(28)
      expect(r.y + r.h).toBeLessThanOrEqual(25)
    }
    // Uniform scale: the two same-sized nodes stay the same projected size.
    expect(projected[0].w).toBeCloseTo(projected[1].w)
    expect(projected[0].h).toBeCloseTo(projected[1].h)
  })

  it('keeps every projected rect visibly sized (min clamp)', () => {
    const projected = projectRectsToBoard([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 100000, y: 100000, w: 1, h: 1 },
    ])
    for (const r of projected) {
      expect(r.w).toBeGreaterThanOrEqual(1.4)
      expect(r.h).toBeGreaterThanOrEqual(1.4)
    }
  })

  it('caps the rendered rect count for huge scenes', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ x: i * 10, y: 0, w: 8, h: 8 }))
    expect(projectRectsToBoard(many).length).toBeLessThanOrEqual(16)
  })
})

describe('applyFavicon', () => {
  afterEach(() => {
    for (const l of document.head.querySelectorAll('link[rel="icon"]')) l.remove()
  })

  it('installs a favicon link and updates it in place', () => {
    applyFavicon('data:image/png;base64,AAA')
    const links = document.head.querySelectorAll('link[rel="icon"]')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('data:image/png;base64,AAA')

    applyFavicon('data:image/png;base64,BBB')
    const again = document.head.querySelectorAll('link[rel="icon"]')
    expect(again).toHaveLength(1)
    expect(again[0]?.getAttribute('href')).toBe('data:image/png;base64,BBB')
  })

  it('restores the static favicon on null (unmount path)', () => {
    applyFavicon('data:image/png;base64,AAA')
    applyFavicon(null)
    const links = document.head.querySelectorAll('link[rel="icon"]')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe(STATIC_FAVICON_HREF)
  })
})

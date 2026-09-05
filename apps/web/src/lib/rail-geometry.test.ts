import { describe, expect, it } from 'vitest'
import { railGeometry, railOffsetToDocumentY, viewportFrame } from './rail-geometry.js'

const blocks = [
  { x: 0, y: 0, w: 300, h: 40 },
  { x: 0, y: 48, w: 460, h: 80 },
  { x: 0, y: 136, w: 120, h: 24 },
]

describe('railGeometry', () => {
  // The whole document fits the rail, so the rail is a map of the document
  // rather than a second thing to scroll.
  it('compresses the document’s full height into the rail', () => {
    const geo = railGeometry(blocks, { railHeight: 80, railWidth: 20 })
    // Content runs 0..160; 80/160 halves it.
    expect(geo.scale).toBeCloseTo(0.5)
    expect(geo.rows[0]).toMatchObject({ top: 0, height: 20 })
    expect(geo.rows[2]).toMatchObject({ top: 68, height: 12 })
  })

  // Line length is what makes a text minimap readable at a glance — a column
  // of equal bars says nothing about the document.
  it('keeps relative block widths, scaled to the rail’s width', () => {
    const geo = railGeometry(blocks, { railHeight: 80, railWidth: 20 })
    expect(geo.rows[1].width).toBe(20)
    expect(geo.rows[2].width).toBeCloseTo((120 / 460) * 20)
  })

  // A row thinner than a pixel is a row nobody can see; the outline exists to
  // show that something is there.
  it('never renders a block thinner than a visible line', () => {
    // The clamp only engages once the document is long enough to compress a
    // block below a pixel: a short one scales at 1 and never reaches it.
    const geo = railGeometry(
      [
        { x: 0, y: 0, w: 400, h: 2 },
        { x: 0, y: 998, w: 400, h: 2 },
      ],
      { railHeight: 100, railWidth: 20 },
    )
    expect(geo.scale).toBeCloseTo(0.1)
    expect(geo.rows[0].height).toBe(1)
  })

  it('never scales up a document shorter than the rail', () => {
    const geo = railGeometry([{ x: 0, y: 0, w: 400, h: 20 }], { railHeight: 500, railWidth: 20 })
    expect(geo.scale).toBe(1)
    expect(geo.rows[0].height).toBe(20)
  })

  it('is empty, not broken, for a document that laid out to nothing', () => {
    const geo = railGeometry([], { railHeight: 80, railWidth: 20 })
    expect(geo.rows).toEqual([])
    expect(geo.contentHeight).toBe(0)
  })

  it('degrades rather than dividing by zero when the rail has no height yet', () => {
    const geo = railGeometry(blocks, { railHeight: 0, railWidth: 20 })
    expect(geo.rows).toEqual([])
  })
})

describe('railOffsetToDocumentY', () => {
  it('maps a press on the rail back to the document position under it', () => {
    const geo = railGeometry(blocks, { railHeight: 80, railWidth: 20 })
    expect(railOffsetToDocumentY(0, geo)).toBe(0)
    expect(railOffsetToDocumentY(40, geo)).toBeCloseTo(80)
  })

  it('clamps a press past either end to the document’s own range', () => {
    const geo = railGeometry(blocks, { railHeight: 80, railWidth: 20 })
    expect(railOffsetToDocumentY(-30, geo)).toBe(0)
    expect(railOffsetToDocumentY(999, geo)).toBeCloseTo(160)
  })
})

describe('viewportFrame', () => {
  it('marks the visible slice of the document on the rail', () => {
    const geo = railGeometry(blocks, { railHeight: 80, railWidth: 20 })
    expect(viewportFrame({ top: 40, height: 40 }, geo)).toEqual({ top: 20, height: 20 })
  })

  // A viewport taller than the document would otherwise draw a frame past the
  // rail's end, which reads as more document below.
  it('never draws a frame taller than the rail', () => {
    const geo = railGeometry(blocks, { railHeight: 80, railWidth: 20 })
    const frame = viewportFrame({ top: 0, height: 10_000 }, geo)
    expect(frame.top).toBe(0)
    expect(frame.height).toBe(80)
  })

  it('keeps a frame for a viewport so small it would round away', () => {
    const geo = railGeometry(blocks, { railHeight: 80, railWidth: 20 })
    expect(viewportFrame({ top: 0, height: 0 }, geo).height).toBeGreaterThan(0)
  })
})

import { describe, expect, it } from 'vitest'
import { edgeLabelAnchor, edgeLabelPlacement } from './edge-label-anchor.js'
import { flattenRoundedEdgePath } from './edge-rounding.js'

describe('edgeLabelAnchor', () => {
  it('returns the arc-length midpoint of a two-segment path', () => {
    // Segments of length 10 then 30: midpoint is 20 along, i.e. 10 into segment 2.
    const path = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 30 },
    ]
    expect(edgeLabelAnchor(path)).toEqual({ x: 10, y: 10 })
  })

  it('sits on the drawn curve, not the corner vertex, for a rounded path', () => {
    // A symmetric right angle: the raw arc-length midpoint IS the corner
    // vertex, which the rounded ink never touches. The anchor must follow
    // the flattened curve instead.
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]
    const anchor = edgeLabelAnchor(path, true)
    expect(anchor).not.toEqual({ x: 100, y: 0 })
    expect(anchor).toEqual(edgeLabelAnchor(flattenRoundedEdgePath(path)))
  })

  it('returns undefined when the path draws no line', () => {
    expect(edgeLabelAnchor([])).toBeUndefined()
    expect(edgeLabelAnchor([{ x: 3, y: 4 }])).toBeUndefined()
    expect(
      edgeLabelAnchor([
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ]),
    ).toBeUndefined()
  })
})

describe('edgeLabelPlacement', () => {
  // Two boxes on one row, 80 tall, with the edge along y = 40 between them.
  const boxes = (gap: number) => [
    { x: 0, y: 0, w: 200, h: 80 },
    { x: 200 + gap, y: 0, w: 200, h: 80 },
  ]
  const line = (gap: number) => [
    { x: 200, y: 40 },
    { x: 200 + gap, y: 40 },
  ]
  const label = { w: 44, h: 16 }

  it('keeps the midpoint when the label fits between the boxes', () => {
    expect(edgeLabelPlacement(line(200), label, boxes(200))).toEqual({ x: 300, y: 40 })
  })

  it('slides a label wider than its gap off the line, above the boxes, keeping its x', () => {
    // A 44px label on a 40px edge covers both boxes on the line; above the
    // row it covers neither. Nearest clear offset wins, so it sits just
    // above the boxes' top rather than as far up as the search reaches.
    const placed = edgeLabelPlacement(line(40), label, boxes(40))
    expect(placed).toBeDefined()
    expect(placed?.x).toBe(220)
    expect((placed?.y ?? 0) + label.h / 2).toBeLessThanOrEqual(0)
    expect((placed?.y ?? 0) + label.h / 2).toBeGreaterThan(-16)
  })

  it('slides sideways for a vertical edge', () => {
    const column = [
      { x: 0, y: 0, w: 200, h: 80 },
      { x: 0, y: 130, w: 200, h: 80 },
    ]
    const drop = [
      { x: 100, y: 80 },
      { x: 100, y: 130 },
    ]
    // 16 tall fits the 50px gap, so a short label stays; a tall one moves.
    expect(edgeLabelPlacement(drop, { w: 44, h: 16 }, column)).toEqual({ x: 100, y: 105 })
    const placed = edgeLabelPlacement(drop, { w: 44, h: 60 }, column)
    expect(placed?.y).toBe(105)
    expect(Math.abs((placed?.x ?? 0) - 100)).toBeGreaterThanOrEqual(22 + 100)
  })

  it('stays on the line when nothing within reach is clear', () => {
    // A label taller than the whole neighbourhood: every offset the search
    // tries still overlaps, and the midpoint is the honest answer.
    const placed = edgeLabelPlacement(line(40), { w: 44, h: 400 }, boxes(40))
    expect(placed).toEqual({ x: 220, y: 40 })
  })

  it('answers undefined for a path that draws no line, like the anchor', () => {
    expect(edgeLabelPlacement([{ x: 1, y: 1 }], label, [])).toBeUndefined()
  })
})

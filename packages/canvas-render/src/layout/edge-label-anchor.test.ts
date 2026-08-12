import { describe, expect, it } from 'vitest'
import { edgeLabelAnchor } from './edge-label-anchor.js'
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

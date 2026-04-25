import { describe, expect, it } from 'vitest'
import { snapArrowEndpoints } from './snap-arrow.js'

// snap-to-edge snaps arrow endpoints to rectangle boundaries. Either endpoint,
// or both, can provide a box. The snapped point is the ray/rectangle
// intersection from the box center toward the opposite endpoint.

describe('snapArrowEndpoints', () => {
  it('returns start/end unchanged when no box is provided', () => {
    const r = snapArrowEndpoints({
      start: { x: 0, y: 0 },
      end: { x: 100, y: 100 },
    })
    expect(r.start).toEqual({ x: 0, y: 0 })
    expect(r.end).toEqual({ x: 100, y: 100 })
  })

  it('snaps endBox to the right-edge midpoint when the arrow approaches from the right', () => {
    // box: (100,0)-(200,100), center (150,50)
    // start: (300, 50) points rightward from the center, so the hit is x=200
    const r = snapArrowEndpoints({
      start: { x: 300, y: 50 },
      end: { x: 150, y: 50 }, // box center
      endBox: { x: 100, y: 0, width: 100, height: 100 },
    })
    expect(r.start).toEqual({ x: 300, y: 50 })
    expect(r.end).toEqual({ x: 200, y: 50 }) // right edge x=200
  })

  it('snaps endBox to the left-edge midpoint when the arrow approaches from the left', () => {
    const r = snapArrowEndpoints({
      start: { x: 0, y: 50 },
      end: { x: 150, y: 50 },
      endBox: { x: 100, y: 0, width: 100, height: 100 },
    })
    expect(r.end).toEqual({ x: 100, y: 50 }) // left edge
  })

  it('snaps endBox to the top-edge midpoint when the arrow approaches from above', () => {
    const r = snapArrowEndpoints({
      start: { x: 150, y: 0 },
      end: { x: 150, y: 50 },
      endBox: { x: 100, y: 0, width: 100, height: 100 },
    })
    // box center (150,50), ray points upward from the center -> y=0
    expect(r.end).toEqual({ x: 150, y: 0 })
  })

  it('snaps endBox to the bottom-edge midpoint when the arrow approaches from below', () => {
    const r = snapArrowEndpoints({
      start: { x: 150, y: 200 },
      end: { x: 150, y: 50 },
      endBox: { x: 100, y: 0, width: 100, height: 100 },
    })
    expect(r.end).toEqual({ x: 150, y: 100 }) // bottom edge y=100
  })

  it('snaps the start point symmetrically when startBox is provided', () => {
    // start-side box: center (50,50), 100x100 square
    // end (300,50) -> right edge x=100
    const r = snapArrowEndpoints({
      start: { x: 50, y: 50 },
      end: { x: 300, y: 50 },
      startBox: { x: 0, y: 0, width: 100, height: 100 },
    })
    expect(r.start).toEqual({ x: 100, y: 50 })
    expect(r.end).toEqual({ x: 300, y: 50 })
  })

  it('snaps both endpoints when startBox and endBox are provided', () => {
    // A: (0,0)-(100,100), center (50,50)
    // B: (200,0)-(300,100), center (250,50)
    // Horizontal line -> A right edge x=100 and B left edge x=200
    const r = snapArrowEndpoints({
      start: { x: 50, y: 50 },
      end: { x: 250, y: 50 },
      startBox: { x: 0, y: 0, width: 100, height: 100 },
      endBox: { x: 200, y: 0, width: 100, height: 100 },
    })
    expect(r.start).toEqual({ x: 100, y: 50 })
    expect(r.end).toEqual({ x: 200, y: 50 })
  })

  it('uses the first intersected edge for diagonal rays', () => {
    // box: (0,0)-(200,100), center (100,50)
    const r = snapArrowEndpoints({
      start: { x: 500, y: 300 },
      end: { x: 100, y: 50 },
      endBox: { x: 0, y: 0, width: 200, height: 100 },
    })
    // dx = 400, dy = 250
    // tx = 0.25, ty = 0.2 -> ty wins, so the ray hits the bottom edge
    expect(r.end).toEqual({ x: 180, y: 100 })
  })

  it('returns the original point when start and end are identical', () => {
    const r = snapArrowEndpoints({
      start: { x: 150, y: 50 },
      end: { x: 150, y: 50 },
      endBox: { x: 100, y: 0, width: 100, height: 100 },
    })
    // Zero direction vector -> no snapping math, keep the original point.
    expect(r.end).toEqual({ x: 150, y: 50 })
  })

  it('accepts any absolute end coordinate even when endBox is provided', () => {
    // end does not need to equal the box center. Internally the algorithm still
    // casts the ray from the box center toward start.
    const r = snapArrowEndpoints({
      start: { x: 500, y: 50 },
      end: { x: 140, y: 30 }, // any point inside the box
      endBox: { x: 100, y: 0, width: 100, height: 100 },
    })
    // box center (150,50) toward start (500,50) -> right edge x=200
    expect(r.end).toEqual({ x: 200, y: 50 })
  })
})

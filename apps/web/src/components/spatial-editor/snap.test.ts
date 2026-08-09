import { describe, expect, it } from 'vitest'
import { type SnapBox, snapBox, snapEdge } from './snap.js'

const box = (x: number, y: number, width = 100, height = 60): SnapBox => ({ x, y, width, height })

// Grid off unless a case is specifically about the grid, so node candidates
// are never silently rescued by a lattice hit.
const NODE_ONLY = { thresholdCanvasPx: 8, gridSize: 0 }
const WITH_GRID = { thresholdCanvasPx: 8, gridSize: 10 }

describe('snapBox — node candidates', () => {
  const other = box(100, 100, 100, 60) // left 100, centre 150, right 200

  it('pulls a near-miss onto another box left edge, and reports the guide', () => {
    const result = snapBox(box(103, 500), [other], NODE_ONLY)
    expect(result.x).toBe(100)
    expect(result.guidesX).toEqual([100])
  })

  it('aligns trailing edge to trailing edge, accounting for width', () => {
    // Moving box is 40 wide; its RIGHT edge at 197 is 3 from the other's 200.
    const result = snapBox(box(157, 500, 40, 60), [other], NODE_ONLY)
    expect(result.x).toBe(160)
    expect(result.guidesX).toEqual([200])
  })

  it('aligns centre to centre', () => {
    // Moving centre at 148 vs other centre 150.
    const result = snapBox(box(128, 500, 40, 60), [other], NODE_ONLY)
    expect(result.x).toBe(130)
    expect(result.guidesX).toEqual([150])
  })

  it('leaves an axis alone when nothing is in range', () => {
    const result = snapBox(box(500, 500), [other], NODE_ONLY)
    expect(result).toEqual({ x: 500, y: 500, guidesX: [], guidesY: [] })
  })

  it('snaps the two axes independently', () => {
    // x is a near-miss on the left edge; y is far from anything.
    const result = snapBox(box(103, 900), [other], NODE_ONLY)
    expect(result.x).toBe(100)
    expect(result.y).toBe(900)
    expect(result.guidesY).toEqual([])
  })

  it('takes the nearest candidate when several are in range', () => {
    const near = box(104, 500)
    const result = snapBox(near, [other, box(106, 500)], NODE_ONLY)
    // 106 is 2 away, 100 is 4 away — the closer one wins.
    expect(result.x).toBe(106)
  })

  it('respects the threshold rather than snapping from any distance', () => {
    const result = snapBox(box(112, 500), [other], NODE_ONLY)
    expect(result.x).toBe(112)
    expect(result.guidesX).toEqual([])
  })
})

describe('snapBox — grid candidates', () => {
  it('snaps to the nearest grid multiple when no node is in range', () => {
    const result = snapBox(box(103, 47), [], WITH_GRID)
    expect(result.x).toBe(100)
    expect(result.y).toBe(50)
  })

  it('draws no guide for a grid hit — there is no content to point at', () => {
    const result = snapBox(box(103, 47), [], WITH_GRID)
    expect(result.guidesX).toEqual([])
    expect(result.guidesY).toEqual([])
  })

  it('prefers a node over the grid at equal distance', () => {
    // Moving x 102: grid 100 is 2 away, and a node left edge at 104 is 2
    // away too. Real content wins, or the lattice would take most ties.
    const result = snapBox(box(102, 500), [box(104, 500)], WITH_GRID)
    expect(result.x).toBe(104)
    expect(result.guidesX).toEqual([104])
  })

  it('still lets a closer grid line win', () => {
    // grid 100 is 1 away; the node edge at 107 is 6 away.
    const result = snapBox(box(101, 500), [box(107, 500)], WITH_GRID)
    expect(result.x).toBe(100)
    expect(result.guidesX).toEqual([])
  })

  it('treats a zero or negative grid size as no grid', () => {
    expect(snapBox(box(103, 47), [], { thresholdCanvasPx: 8, gridSize: 0 }).x).toBe(103)
    expect(snapBox(box(103, 47), [], { thresholdCanvasPx: 8, gridSize: -10 }).x).toBe(103)
  })
})

describe('snapBox — totality', () => {
  it('returns the input unchanged for a non-finite box', () => {
    const broken = { x: Number.NaN, y: 0, width: 10, height: 10 }
    expect(snapBox(broken, [box(0, 0)], WITH_GRID)).toMatchObject({ x: Number.NaN, y: 0 })
  })

  it('skips non-finite neighbours instead of throwing', () => {
    const others = [{ x: Number.NaN, y: 0, width: 10, height: 10 }, box(104, 500)]
    expect(snapBox(box(102, 500), others, NODE_ONLY).x).toBe(104)
  })

  it('rejects a non-finite or negative threshold by not snapping', () => {
    expect(
      snapBox(box(103, 500), [box(100, 500)], { thresholdCanvasPx: Number.NaN, gridSize: 10 }).x,
    ).toBe(103)
    expect(snapBox(box(103, 500), [box(100, 500)], { thresholdCanvasPx: -1, gridSize: 10 }).x).toBe(
      103,
    )
  })

  it('handles an empty neighbour list', () => {
    expect(snapBox(box(103, 500), [], NODE_ONLY)).toEqual({
      x: 103,
      y: 500,
      guidesX: [],
      guidesY: [],
    })
  })
})

describe('snapEdge — one dragged edge, not a whole box', () => {
  // A resize moves an EDGE, so its only line is the edge itself. Reusing the
  // move candidates would let the box's centre or far edge pull the handle,
  // which reads as the handle fighting the pointer.
  const other = box(100, 100, 100, 60) // x: 100 / 150 / 200, y: 100 / 130 / 160

  it('pulls a near-miss edge onto a neighbour leading edge', () => {
    expect(snapEdge(103, [other], NODE_ONLY, 'x')).toEqual({ position: 100, guide: 100 })
  })

  it('snaps to a neighbour trailing edge', () => {
    expect(snapEdge(197, [other], NODE_ONLY, 'x')).toEqual({ position: 200, guide: 200 })
  })

  it('snaps to a neighbour centre', () => {
    expect(snapEdge(148, [other], NODE_ONLY, 'x')).toEqual({ position: 150, guide: 150 })
  })

  it('projects the other axis when asked for y', () => {
    expect(snapEdge(133, [other], NODE_ONLY, 'y')).toEqual({ position: 130, guide: 130 })
    // The x lines must not leak into a y snap.
    expect(snapEdge(203, [other], NODE_ONLY, 'y')).toEqual({ position: 203, guide: undefined })
  })

  it('falls back to the grid, which draws no guide', () => {
    expect(snapEdge(503, [], WITH_GRID, 'x')).toEqual({ position: 500, guide: undefined })
  })

  it('prefers a neighbour over the grid at equal distance', () => {
    expect(snapEdge(102, [box(104, 500)], WITH_GRID, 'x')).toEqual({ position: 104, guide: 104 })
  })

  it('leaves an edge alone when nothing is in range', () => {
    expect(snapEdge(500, [other], NODE_ONLY, 'x')).toEqual({ position: 500, guide: undefined })
  })

  it('is total on degenerate input', () => {
    expect(snapEdge(Number.NaN, [other], NODE_ONLY, 'x')).toEqual({
      position: Number.NaN,
      guide: undefined,
    })
    expect(snapEdge(103, [other], { thresholdCanvasPx: -1, gridSize: 10 }, 'x')).toEqual({
      position: 103,
      guide: undefined,
    })
    // A non-finite neighbour is skipped, not fatal.
    expect(
      snapEdge(103, [{ x: Number.NaN, y: 0, width: 1, height: 1 }, other], NODE_ONLY, 'x'),
    ).toEqual({ position: 100, guide: 100 })
  })
})

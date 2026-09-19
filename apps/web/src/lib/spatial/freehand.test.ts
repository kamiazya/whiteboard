import { VISUAL_EDGES_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import {
  FREEHAND_MAX_POINTS,
  freehandLine,
  MIN_STROKE_TRAVEL_PX,
  STROKE_TOLERANCE_PX,
  simplifyStroke,
} from './freehand.js'
import type { Point } from './viewport.js'

const at = (x: number, y: number): Point => ({ x, y })

describe('simplifyStroke', () => {
  it('collapses a jittery straight run to its two ends', () => {
    const jittery = Array.from({ length: 40 }, (_, i) => at(i * 10, i % 2 === 0 ? 0 : 0.4))
    expect(simplifyStroke(jittery, STROKE_TOLERANCE_PX)).toEqual([at(0, 0), at(390, 0.4)])
  })

  it('keeps a corner the stroke really turned', () => {
    const corner = [at(0, 0), at(50, 0), at(100, 0), at(100, 50), at(100, 100)]
    expect(simplifyStroke(corner, STROKE_TOLERANCE_PX)).toEqual([
      at(0, 0),
      at(100, 0),
      at(100, 100),
    ])
  })

  it('leaves a stroke of fewer than three points alone', () => {
    expect(simplifyStroke([at(1, 2)], STROKE_TOLERANCE_PX)).toEqual([at(1, 2)])
    expect(simplifyStroke([at(1, 2), at(3, 4)], STROKE_TOLERANCE_PX)).toEqual([at(1, 2), at(3, 4)])
  })
})

describe('freehandLine', () => {
  it('ends the ink where the pointer started and stopped, with no arrowhead', () => {
    const drawn = [at(0, 0), at(40, 60), at(90, 10), at(140, 80)]
    const line = freehandLine('ink-1', drawn, 1)
    expect(line?.from).toEqual({ kind: 'point', point: at(0, 0), end: 'none' })
    expect(line?.to).toEqual({ kind: 'point', point: at(140, 80), end: 'none' })
  })

  it('stores the turns it kept as bends, endpoints excluded', () => {
    const drawn = [at(0, 0), at(40, 60), at(90, 10), at(140, 80)]
    expect(freehandLine('ink-1', drawn, 1)?.bends).toEqual([at(40, 60), at(90, 10)])
  })

  // Measured, not assumed: a point-ended line with NO bends is routed, and a
  // node anywhere near it turns the straight run into an orthogonal detour —
  // `[0,0] -> [0,56] -> [400,56] -> [400,300]` for a stroke drawn from 0,0 to
  // 400,300 past one node. Storing a bend is what makes the renderer draw the
  // path the person drew instead of computing one over it.
  it('stores a midpoint for a straight stroke, so nothing routes it', () => {
    const line = freehandLine('ink-1', [at(0, 0), at(50, 50), at(100, 100)], 1)
    expect(line?.bends).toEqual([at(50, 50)])
  })

  it('is nothing at all for a tap', () => {
    expect(freehandLine('ink-1', [at(10, 10), at(10, 10), at(10.2, 9.9)], 1)).toBeUndefined()
    expect(freehandLine('ink-1', [], 1)).toBeUndefined()
  })

  it('measures the tap floor in screen pixels, so zoom cannot redefine a tap', () => {
    // The same travel in DOCUMENT units: comfortably a stroke at zoom 1, and
    // a third of a screen pixel — a tap — when the board is drawn at a
    // quarter size. Jitter is what the hand did in front of a display.
    const travelled = [at(0, 0), at(MIN_STROKE_TRAVEL_PX + 1, 0)]
    expect(freehandLine('ink-1', travelled, 1)).toBeDefined()
    expect(freehandLine('ink-1', travelled, 0.25)).toBeUndefined()
  })

  it('asks to be DRAWN as a curve, so the samples are not read as corners', () => {
    // The stroke's own geometry is the bends; this is the other half — a
    // path of straight runs between kept samples reads as a jagged line
    // however dense it is. `curved` is what makes the renderer round each
    // corner into the quadratic its neighbours' midpoints define, which is
    // the same smoothing a drawing app applies to a captured stroke.
    const line = freehandLine('ink-1', [at(0, 0), at(40, 60), at(90, 10), at(140, 80)], 1)
    expect(line?.facets?.[VISUAL_EDGES_KEY]).toEqual({ routing: 'curved' })
  })

  it('bounds what one stroke writes, however long the pointer was down', () => {
    // A minute of drawing at 120Hz is thousands of samples, and every one of
    // them would be a coordinate in the document's own record.
    const long = Array.from({ length: 4000 }, (_, i) => at(i, Math.sin(i / 3) * 40))
    const line = freehandLine('ink-1', long, 1)
    expect(line).toBeDefined()
    expect((line?.bends?.length ?? 0) + 2).toBeLessThanOrEqual(FREEHAND_MAX_POINTS)
  })

  it('keeps the shape recognisable while it bounds it', () => {
    // The bound must not be met by throwing the drawing away: a sine still
    // has to come back with its turns in it.
    const long = Array.from({ length: 4000 }, (_, i) => at(i, Math.sin(i / 3) * 40))
    expect(freehandLine('ink-1', long, 1)?.bends?.length ?? 0).toBeGreaterThan(20)
  })
})

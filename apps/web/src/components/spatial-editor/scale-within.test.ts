import { describe, expect, it } from 'vitest'
import { type Box, scaleBoxWithin, unionBox } from '../../lib/spatial/geometry.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height })

describe('unionBox', () => {
  it('covers every box it is given', () => {
    expect(unionBox([box(10, 20, 30, 40), box(100, 0, 10, 10)])).toEqual(box(10, 0, 100, 60))
  })

  it('is the box itself for a single member', () => {
    expect(unionBox([box(5, 6, 7, 8)])).toEqual(box(5, 6, 7, 8))
  })

  it('has no answer for an empty selection', () => {
    expect(unionBox([])).toBeUndefined()
  })
})

describe('scaleBoxWithin', () => {
  it('leaves a member alone when the enclosing box did not change', () => {
    const start = box(0, 0, 200, 100)
    expect(scaleBoxWithin(start, start, box(20, 10, 50, 30))).toEqual(box(20, 10, 50, 30))
  })

  it('maps a member that fills the box onto the new box exactly', () => {
    const start = box(0, 0, 200, 100)
    const next = box(-10, 5, 400, 50)
    expect(scaleBoxWithin(start, next, start)).toEqual(next)
  })

  it('scales offset and size together, so relative position survives', () => {
    // Member sits at the horizontal midpoint and half the width; doubling the
    // enclosing box must keep both facts true.
    const start = box(0, 0, 200, 100)
    const next = box(0, 0, 400, 200)
    expect(scaleBoxWithin(start, next, box(100, 0, 100, 50))).toEqual(box(200, 0, 200, 100))
  })

  it('carries the origin shift of a handle that moves the min side', () => {
    const start = box(100, 100, 200, 100)
    // Dragging the NW handle 50/20 inward: same size, new origin.
    const next = box(150, 120, 150, 80)
    expect(scaleBoxWithin(start, next, box(100, 100, 100, 50))).toEqual(box(150, 120, 75, 40))
  })

  // A degenerate axis has no ratio to preserve. Dividing by it yields
  // Infinity/NaN and would put the node at a coordinate no schema accepts.
  it('passes a member through unscaled on an axis the enclosing box has collapsed', () => {
    const start = box(0, 0, 0, 100)
    const next = box(0, 0, 50, 200)
    expect(scaleBoxWithin(start, next, box(0, 0, 0, 50))).toEqual(box(0, 0, 0, 100))
  })

  // JSON Canvas geometry is integer, and a node scaled to nothing is
  // unrecoverable — it can never be grabbed to grow again.
  it('returns integers and never collapses a member to zero', () => {
    const result = scaleBoxWithin(box(0, 0, 1000, 1000), box(0, 0, 3, 3), box(0, 0, 100, 100))
    expect(Number.isInteger(result.width)).toBe(true)
    expect(Number.isInteger(result.height)).toBe(true)
    expect(result.width).toBeGreaterThanOrEqual(1)
    expect(result.height).toBeGreaterThanOrEqual(1)
  })
})

const coord = fc.integer({ min: -500, max: 500 })
const extent = fc.integer({ min: 1, max: 500 })
const anyBox = fc.record({ x: coord, y: coord, width: extent, height: extent })

// 15s, not the project's 5s default: the identity property alone measures
// 1194ms for its 200 runs on an IDLE machine, and CI's stress job runs every
// changed file's repeats in one two-core process — 5s expired there twice
// (two different seeds, both `Test timed out`, i.e. the property never
// failed; integrator-flow.md's load-dependent family). Budget sized on the
// measurement, never a pinned seed.
describe('scaleBoxWithin properties', { timeout: 15_000 }, () => {
  fcTest.prop([anyBox, anyBox], withDefaults())(
    'is the identity when the enclosing box is unchanged',
    (enclosing, member) => {
      expect(scaleBoxWithin(enclosing, enclosing, member)).toEqual(member)
    },
  )

  fcTest.prop([anyBox, anyBox, fc.double({ min: 0, max: 1, noNaN: true })], withDefaults())(
    'anchors a member to the box it was scaled into, and never emits a non-finite coordinate',
    (start, next, t) => {
      // A member built to sit inside `start` by construction.
      const member = {
        x: start.x + Math.round(start.width * t * 0.5),
        y: start.y + Math.round(start.height * t * 0.5),
        width: Math.max(1, Math.round(start.width * 0.4)),
        height: Math.max(1, Math.round(start.height * 0.4)),
      }
      const scaled = scaleBoxWithin(start, next, member)
      // Rounding and the one-pixel floor can push a member a pixel past the
      // edge; the guarantee is that it stays anchored to the box, not that it
      // is clipped by it.
      expect(scaled.x).toBeGreaterThanOrEqual(next.x - 1)
      expect(scaled.y).toBeGreaterThanOrEqual(next.y - 1)
      for (const value of Object.values(scaled)) {
        expect(Number.isFinite(value)).toBe(true)
      }
    },
  )
})

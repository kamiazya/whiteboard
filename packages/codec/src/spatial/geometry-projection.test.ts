import { spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fromJsonCanvas, JSON_CANVAS_PROJECTION, toJsonCanvas } from './projection.js'

/**
 * JSON Canvas 1.0 specifies geometry in integer pixels. The model does not:
 * ink is sub-pixel by nature, and a model that rounds before it draws has
 * thrown away what a pen measured
 * ([ADR-0037](../../../../docs/contributing/adr/0037-model-and-format.md)).
 *
 * So this is the first field position whose projection is `degraded` rather
 * than `native` or `extension` — the ledger's third kind, which until now
 * nothing exercised.
 */
const withGeometry = (x: number, y: number, width: number, height: number) => ({
  nodes: [{ id: 'n1', type: 'text' as const, text: 'a', x, y, width, height }],
  edges: [],
})

describe('geometry the format cannot state', () => {
  it('accepts a sub-pixel position and size', () => {
    expect(spatialCanvasSchema.safeParse(withGeometry(1.5, -2.25, 10.5, 0.75)).success).toBe(true)
  })

  it('still refuses a coordinate that JSON cannot carry', () => {
    // `JSON.stringify(Infinity)` is `null`, and a NaN corner is not a corner.
    // Widening to a float is not widening to any number at all.
    expect(
      spatialCanvasSchema.safeParse(withGeometry(Number.POSITIVE_INFINITY, 0, 1, 1)).success,
    ).toBe(false)
    expect(spatialCanvasSchema.safeParse(withGeometry(Number.NaN, 0, 1, 1)).success).toBe(false)
  })

  it('still refuses a negative size, which is not a box', () => {
    expect(spatialCanvasSchema.safeParse(withGeometry(0, 0, -1, 1)).success).toBe(false)
  })

  it('rounds to the nearest integer pixel on the way out', () => {
    const wire = toJsonCanvas(withGeometry(1.5, -2.25, 10.5, 0.4))
    expect(wire.nodes[0]).toMatchObject({ x: 2, y: -2, width: 11, height: 0 })
  })

  it('declares the rounding in the ledger, so a reader is told before exporting', () => {
    for (const path of ['nodes[].x', 'nodes[].y', 'nodes[].width', 'nodes[].height']) {
      expect(JSON_CANVAS_PROJECTION[path]).toEqual({
        kind: 'degraded',
        to: expect.stringContaining('integer'),
      })
    }
  })

  it('round-trips exactly over the expressible subset — geometry already integral', () => {
    const canvas = withGeometry(3, 4, 20, 10)
    expect(fromJsonCanvas(toJsonCanvas(canvas))).toEqual(canvas)
  })
})

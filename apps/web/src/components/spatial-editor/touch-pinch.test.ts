// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { panBy, zoomAt } from '../../lib/spatial/viewport.js'
import { computePinchUpdate } from './touch-pinch.js'

describe('computePinchUpdate', () => {
  it('two fingers translating together pan without zooming', () => {
    const update = computePinchUpdate(
      { a: { x: 100, y: 100 }, b: { x: 200, y: 100 } },
      { a: { x: 130, y: 120 }, b: { x: 230, y: 120 } },
    )
    expect(update.panDelta).toEqual({ x: 30, y: 20 })
    expect(update.zoomFactor).toBe(1)
  })

  it('spreading fingers zooms in around the (unmoved) centroid', () => {
    const update = computePinchUpdate(
      { a: { x: 140, y: 100 }, b: { x: 160, y: 100 } },
      { a: { x: 130, y: 100 }, b: { x: 170, y: 100 } },
    )
    expect(update.panDelta).toEqual({ x: 0, y: 0 })
    expect(update.zoomFactor).toBe(2)
    expect(update.anchor).toEqual({ x: 150, y: 100 })
  })

  it('pinching fingers together zooms out', () => {
    const update = computePinchUpdate(
      { a: { x: 100, y: 100 }, b: { x: 200, y: 100 } },
      { a: { x: 125, y: 100 }, b: { x: 175, y: 100 } },
    )
    expect(update.zoomFactor).toBe(0.5)
  })

  it('a degenerate (near-zero) finger distance degrades to pan-only', () => {
    const update = computePinchUpdate(
      { a: { x: 100, y: 100 }, b: { x: 100.2, y: 100 } },
      { a: { x: 150, y: 100 }, b: { x: 170, y: 100 } },
    )
    expect(update.zoomFactor).toBe(1)
  })

  it('keeps the canvas point under the centroid fixed when applied pan-then-zoom', () => {
    // The invariant that makes a pinch feel physical: whatever content sat
    // under the fingers' midpoint stays under it across the frame.
    const vp = { x: 40, y: 60, zoom: 1.5 }
    const prev = { a: { x: 100, y: 200 }, b: { x: 300, y: 200 } }
    const next = { a: { x: 120, y: 240 }, b: { x: 360, y: 240 } }
    const update = computePinchUpdate(prev, next)

    const prevCentroid = { x: 200, y: 200 }
    const canvasUnderCentroid = {
      x: prevCentroid.x / vp.zoom + vp.x,
      y: prevCentroid.y / vp.zoom + vp.y,
    }

    const applied = zoomAt(panBy(vp, update.panDelta), update.anchor, update.zoomFactor)
    const screenAfter = {
      x: (canvasUnderCentroid.x - applied.x) * applied.zoom,
      y: (canvasUnderCentroid.y - applied.y) * applied.zoom,
    }
    expect(screenAfter.x).toBeCloseTo(update.anchor.x, 6)
    expect(screenAfter.y).toBeCloseTo(update.anchor.y, 6)
  })
})

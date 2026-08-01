import { describe, expect, it } from 'vitest'
import { canvasToScreen, clampZoom, screenToCanvas, zoomAt } from './viewport.js'

describe('screenToCanvas / canvasToScreen', () => {
  it('round-trips a screen point through an arbitrary viewport', () => {
    const vp = { x: 40, y: -10, zoom: 2 }
    const screenPoint = { x: 120, y: 80 }
    const canvasPoint = screenToCanvas(screenPoint, vp)
    const roundTripped = canvasToScreen(canvasPoint, vp)
    expect(roundTripped.x).toBeCloseTo(screenPoint.x)
    expect(roundTripped.y).toBeCloseTo(screenPoint.y)
  })
})

describe('zoomAt', () => {
  it('keeps the canvas point under the anchor fixed after zooming', () => {
    const vp = { x: 0, y: 0, zoom: 1 }
    const anchor = { x: 200, y: 150 }
    const before = screenToCanvas(anchor, vp)
    const zoomed = zoomAt(vp, anchor, 2)
    const after = screenToCanvas(anchor, zoomed)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })
})

describe('clampZoom', () => {
  it('clamps to the documented range', () => {
    expect(clampZoom(0)).toBeGreaterThan(0)
    expect(clampZoom(-5)).toBeGreaterThan(0)
    expect(clampZoom(1000)).toBeLessThanOrEqual(10)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(10)
  })
})

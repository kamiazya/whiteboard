import { describe, expect, it } from 'vitest'
import {
  canvasToScreen,
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  screenToCanvas,
  viewportTransformCss,
  zoomAt,
} from './viewport.js'

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

  it('clamps exactly at the documented MIN_ZOOM/MAX_ZOOM bounds', () => {
    expect(clampZoom(MIN_ZOOM - 1)).toBe(MIN_ZOOM)
    expect(clampZoom(MAX_ZOOM + 1)).toBe(MAX_ZOOM)
  })
})

describe('panBy', () => {
  it('moves the viewport origin opposite the screen-space delta, scaled by zoom', () => {
    const vp = { x: 5, y: -3, zoom: 2 }
    const next = panBy(vp, { x: 10, y: 20 })
    expect(next).toEqual({ x: 0, y: -13, zoom: 2 })
  })

  it('never mutates its input viewport', () => {
    const vp = { x: 0, y: 0, zoom: 1 }
    const snapshot = { ...vp }
    panBy(vp, { x: 5, y: 5 })
    expect(vp).toEqual(snapshot)
  })
})

describe('viewportTransformCss', () => {
  it('renders a scale+translate CSS transform from the viewport', () => {
    expect(viewportTransformCss({ x: 10, y: -5, zoom: 2 })).toBe('scale(2) translate(-10px, 5px)')
  })
})

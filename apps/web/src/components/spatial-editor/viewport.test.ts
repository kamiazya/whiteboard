import { describe, expect, it } from 'vitest'
import {
  canvasToScreen,
  clampZoom,
  contentBounds,
  fitViewportToBoxes,
  frameViewport,
  IDENTITY_VIEWPORT,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  panToShowTarget,
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

describe('fitViewportToBoxes', () => {
  it('fits the top-left of the union of the given boxes at identity zoom', () => {
    const boxes = [
      { x: 30, y: 40, width: 10, height: 10 },
      { x: 10, y: 60, width: 5, height: 5 },
    ]
    expect(fitViewportToBoxes(boxes)).toEqual({ x: 10, y: 40, zoom: 1 })
  })

  it('degrades to IDENTITY_VIEWPORT for an empty list', () => {
    expect(fitViewportToBoxes([])).toEqual(IDENTITY_VIEWPORT)
  })

  it('degrades to IDENTITY_VIEWPORT when every box is non-finite', () => {
    const boxes = [
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
      { x: Number.NEGATIVE_INFINITY, y: Number.NaN, width: 5, height: 5 },
    ]
    expect(fitViewportToBoxes(boxes)).toEqual(IDENTITY_VIEWPORT)
  })

  it('ignores non-finite boxes while fitting the remaining finite ones', () => {
    const boxes = [
      { x: Number.NaN, y: Number.NaN, width: 10, height: 10 },
      { x: 15, y: 25, width: 5, height: 5 },
    ]
    expect(fitViewportToBoxes(boxes)).toEqual({ x: 15, y: 25, zoom: 1 })
  })
})

describe('contentBounds', () => {
  const boxes = [
    { id: 'a', box: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'b', box: { x: 100, y: 40, width: 10, height: 10 } },
    { id: 'c', box: { x: Number.NaN, y: 0, width: 10, height: 10 } },
  ]

  it('unions every finite box when no ids filter is given', () => {
    expect(contentBounds(boxes)).toEqual({ minX: 0, minY: 0, maxX: 110, maxY: 50 })
  })

  it('restricts the union to the given ids, ignoring non-members', () => {
    expect(contentBounds(boxes, new Set(['a']))).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
  })

  it('ignores a non-finite box even when it is a named member', () => {
    expect(contentBounds(boxes, new Set(['c']))).toBeUndefined()
  })

  it('degrades to undefined for an empty list', () => {
    expect(contentBounds([])).toBeUndefined()
  })
})

describe('frameViewport', () => {
  const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 }

  it('never magnifies past 1:1 even when the container is far larger than the content', () => {
    const vp = frameViewport(bounds, { width: 2000, height: 2000 }, 1, 24)
    expect(vp.zoom).toBe(1)
  })

  it('shrinks to fit an oversized box, clamped to [MIN_ZOOM, MAX_ZOOM]', () => {
    const vp = frameViewport(
      { minX: 0, minY: 0, maxX: 100_000, maxY: 100_000 },
      { width: 800, height: 600 },
      1,
      24,
    )
    expect(vp.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
    expect(vp.zoom).toBeLessThanOrEqual(MAX_ZOOM)
  })

  it("the bounds' center maps to the container's screen center", () => {
    const containerSize = { width: 800, height: 600 }
    const vp = frameViewport(bounds, containerSize, 1, 24)
    const mapped = canvasToScreen({ x: 100, y: 50 }, vp)
    expect(mapped.x).toBeCloseTo(containerSize.width / 2)
    expect(mapped.y).toBeCloseTo(containerSize.height / 2)
  })

  it('a null containerSize (root not yet measured) keeps currentZoom and still pans', () => {
    const vp = frameViewport(bounds, null, 3, 24)
    expect(vp.zoom).toBe(3)
    // center defaults to screen (0,0) — content center maps there too.
    expect(canvasToScreen({ x: 100, y: 50 }, vp)).toEqual({ x: 0, y: 0 })
  })
})

describe('panToShowTarget', () => {
  const containerSize = { width: 800, height: 600 }

  it('returns undefined (no-op) when the box already fits fully on screen', () => {
    const vp = { x: 0, y: 0, zoom: 1 }
    expect(panToShowTarget({ x: 10, y: 10, width: 50, height: 50 }, vp, containerSize)).toBe(
      undefined,
    )
  })

  it('pans to center the box, keeping the current zoom, when it does not fit', () => {
    const vp = { x: 0, y: 0, zoom: 2 }
    const box = { x: 5000, y: 5000, width: 100, height: 100 }
    const next = panToShowTarget(box, vp, containerSize)
    expect(next?.zoom).toBe(2)
    const centerScreen = canvasToScreen({ x: 5050, y: 5050 }, next as typeof vp)
    expect(centerScreen.x).toBeCloseTo(containerSize.width / 2)
    expect(centerScreen.y).toBeCloseTo(containerSize.height / 2)
  })

  it('returns undefined when containerSize is null (root not yet measured)', () => {
    const vp = { x: 0, y: 0, zoom: 1 }
    expect(panToShowTarget({ x: 5000, y: 5000, width: 10, height: 10 }, vp, null)).toBe(undefined)
  })
})

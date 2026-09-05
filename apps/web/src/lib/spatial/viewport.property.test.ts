// @vitest-environment node
// Containment property for frameViewport: whenever the fit-zoom is not
// clamped at MIN_ZOOM, the framed box stays fully inside the container
// (inset by the frame margin), and the content center always lands on the
// container's screen center. Mutation-checked by dropping the margin or the
// min(1, ...) clamp in viewport.ts and confirming this goes red.
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { canvasToScreen, frameViewport, MIN_ZOOM } from './viewport.js'

// Both smaller-than-container and larger-than-container boxes are needed:
// an all-larger generator never exercises the min(1, ...) magnify guard,
// and an all-smaller one never exercises the shrink-to-fit arm — either
// gap would make the containment check pass vacuously on the untested arm.
const boundsArb = fc
  .record({
    x: fc.integer({ min: -2000, max: 2000 }),
    y: fc.integer({ min: -2000, max: 2000 }),
    width: fc.integer({ min: 1, max: 4000 }),
    height: fc.integer({ min: 1, max: 4000 }),
  })
  .map((box) => ({
    minX: box.x,
    minY: box.y,
    maxX: box.x + box.width,
    maxY: box.y + box.height,
  }))

const containerArb = fc.record({
  width: fc.integer({ min: 100, max: 1600 }),
  height: fc.integer({ min: 100, max: 1200 }),
})

const marginArb = fc.integer({ min: 0, max: 40 })

describe('frameViewport properties', () => {
  fcTest.prop([boundsArb, containerArb, marginArb], withDefaults({ numRuns: 100 }))(
    'the content center always maps to the container center',
    (bounds, containerSize, marginPx) => {
      const vp = frameViewport(bounds, containerSize, 1, marginPx)
      const contentCenter = {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      }
      const mapped = canvasToScreen(contentCenter, vp)
      expect(mapped.x).toBeCloseTo(containerSize.width / 2, 6)
      expect(mapped.y).toBeCloseTo(containerSize.height / 2, 6)
    },
  )

  fcTest.prop([boundsArb, containerArb, marginArb], withDefaults({ numRuns: 100 }))(
    'when the fit-zoom is not clamped at MIN_ZOOM, every box corner maps inside the margin-inset container',
    (bounds, containerSize, marginPx) => {
      const vp = frameViewport(bounds, containerSize, 1, marginPx)
      if (vp.zoom <= MIN_ZOOM) return // clamp arm: containment is not guaranteed by design
      const corners = [
        { x: bounds.minX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.minY },
        { x: bounds.minX, y: bounds.maxY },
        { x: bounds.maxX, y: bounds.maxY },
      ]
      for (const corner of corners) {
        const mapped = canvasToScreen(corner, vp)
        expect(mapped.x).toBeGreaterThanOrEqual(marginPx - 1e-6)
        expect(mapped.x).toBeLessThanOrEqual(containerSize.width - marginPx + 1e-6)
        expect(mapped.y).toBeGreaterThanOrEqual(marginPx - 1e-6)
        expect(mapped.y).toBeLessThanOrEqual(containerSize.height - marginPx + 1e-6)
      }
    },
  )
})

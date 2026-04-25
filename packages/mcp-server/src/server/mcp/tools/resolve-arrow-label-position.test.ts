import { describe, it, expect } from 'vitest'
import { resolveArrowLabelPosition } from './resolve-arrow-label-position.js'
//   - width / height: text bbox
//

describe('resolveArrowLabelPosition', () => {
  it('case 292', () => {
    // text "EDGE"(4 chars * 11 = 44 width, 24 height)
    // top-left = (100-22, 94-12) = (78, 82)
    const r = resolveArrowLabelPosition({
      start: { x: 0, y: 100 },
      end: { x: 200, y: 100 },
      text: 'EDGE',
    })
    expect(r).toEqual({
      target: { x: 78, y: 82 },
      width: 44,
      height: 24,
      text: 'EDGE',
    })
  })

  it('case 293', () => {
    const r = resolveArrowLabelPosition({
      start: { x: 100, y: 0 },
      end: { x: 100, y: 200 },
      text: 'X',
    })
    expect(r.target).toEqual({ x: 88.5, y: 88 })
    expect(r.width).toBe(11)
    expect(r.height).toBe(24)
  })

  it('case 294', () => {
    const r = resolveArrowLabelPosition({
      start: { x: 0, y: 100 },
      end: { x: 100, y: 100 },
      text: 'A',
      offset: 20,
    })
    expect(r.target).toEqual({ x: 44.5, y: 68 })
  })

  it('case 295', () => {
    const r = resolveArrowLabelPosition({
      start: { x: 0, y: 0 },
      end: { x: 100, y: 100 },
      text: 'A',
      offset: 6,
    })
    const expectedCx = 50 + 6 / Math.SQRT2
    const expectedCy = 50 - 6 / Math.SQRT2
    expect(r.target.x).toBeCloseTo(expectedCx - 11 / 2, 3)
    expect(r.target.y).toBeCloseTo(expectedCy - 12, 3)
  })

  it('case 296', () => {
    const r = resolveArrowLabelPosition({
      start: { x: 50, y: 50 },
      end: { x: 50, y: 50 },
      text: 'X',
    })
    expect(r.target).toEqual({ x: 44.5, y: 38 })
  })

  it('case 297', () => {
    const r = resolveArrowLabelPosition({
      start: { x: 0, y: 100 },
      end: { x: 200, y: 100 },
      text: 'EDGE',
      offset: 0,
    })
    expect(r.target).toEqual({ x: 78, y: 88 })
  })

  it('case 298', () => {
    const r = resolveArrowLabelPosition({
      start: { x: 0, y: 100 },
      end: { x: 200, y: 100 },
      text: '',
    })
    expect(r.width).toBe(0)
    expect(r.height).toBe(24)
  })
  describe('suite 8', () => {
    it('case 299', () => {
      const r = resolveArrowLabelPosition({
        start: { x: 0, y: 100 },
        end: { x: 200, y: 100 },
        text: 'EDGE',
        side: 'below',
      })
      // top-left=(78, 94)
      expect(r.target).toEqual({ x: 78, y: 94 })
    })

    it('case 300', () => {
      const r = resolveArrowLabelPosition({
        start: { x: 0, y: 100 },
        end: { x: 200, y: 100 },
        text: 'EDGE',
        side: 'above',
      })
      expect(r.target).toEqual({ x: 78, y: 82 })
    })

    it('case 301', () => {
      // dx=0, dy=200, rawNx=-1, rawNy=0
      const r = resolveArrowLabelPosition({
        start: { x: 100, y: 0 },
        end: { x: 100, y: 200 },
        text: 'X',
        side: 'right',
      })
      expect(r.target).toEqual({ x: 100.5, y: 88 })
    })

    it('case 302', () => {
      const r = resolveArrowLabelPosition({
        start: { x: 100, y: 0 },
        end: { x: 100, y: 200 },
        text: 'X',
        side: 'left',
      })
      expect(r.target).toEqual({ x: 88.5, y: 88 })
    })

    it('case 303', () => {
      // start=(0,0), end=(100,100), mid=(50,50)
      const r = resolveArrowLabelPosition({
        start: { x: 0, y: 0 },
        end: { x: 100, y: 100 },
        text: 'A',
        offset: 6,
        side: 'below',
      })
      const cx = 50 + -6 / Math.SQRT2
      const cy = 50 + 6 / Math.SQRT2
      expect(r.target.x).toBeCloseTo(cx - 11 / 2, 3)
      expect(r.target.y).toBeCloseTo(cy - 12, 3)
    })

    it('case 304', () => {
      const r = resolveArrowLabelPosition({
        start: { x: 0, y: 100 },
        end: { x: 200, y: 100 },
        text: 'EDGE',
        side: 'left',
      })
      expect(r.target).toEqual({ x: 78, y: 82 })
    })

    it('case 305', () => {
      const r = resolveArrowLabelPosition({
        start: { x: 0, y: 100 },
        end: { x: 200, y: 100 },
        text: 'EDGE',
      })
      expect(r.target).toEqual({ x: 78, y: 82 })
    })
  })
  describe('vertical arrow auto-widen offset for wide labels', () => {
    it('case 306', () => {
      const TEXT = 'spawn + inject'
      const r = resolveArrowLabelPosition({
        start: { x: 100, y: 0 },
        end: { x: 100, y: 200 },
        text: TEXT,
      })
      const rightEdge = r.target.x + r.width
      const leftEdge = r.target.x
      expect(rightEdge <= 100 || leftEdge >= 100).toBe(true)
    })

    it('case 307', () => {
      const r = resolveArrowLabelPosition({
        start: { x: 100, y: 0 },
        end: { x: 100, y: 200 },
        text: 'X',
      })
      expect(r.target).toEqual({ x: 88.5, y: 88 })
    })

    it('case 308', () => {
      const r = resolveArrowLabelPosition({
        start: { x: 100, y: 0 },
        end: { x: 100, y: 200 },
        text: 'spawn + inject',
        offset: 6,
      })
      const centerX = r.target.x + r.width / 2
      expect(centerX).toBeCloseTo(94, 1)
      expect(r.target.x + r.width).toBeGreaterThan(100) // Crossing the center means widen did not trigger
    })

    it('case 309', () => {
      const r = resolveArrowLabelPosition({
        start: { x: 0, y: 100 },
        end: { x: 200, y: 100 },
        text: 'spawn + inject',
      })
      const centerX = r.target.x + r.width / 2
      expect(centerX).toBeCloseTo(100, 1)
      expect(r.target.y).toBe(82) // Default above-placement for a horizontal arrow
    })
  })
})
describe('resolveArrowLabelPosition: obstacle collision avoidance', () => {
  const HORIZONTAL = {
    start: { x: 0, y: 100 },
    end: { x: 200, y: 100 },
    text: 'EDGE',
  }

  it('case 310', () => {
    const r = resolveArrowLabelPosition({
      ...HORIZONTAL,
      obstacles: [
        { x: 500, y: 500, width: 50, height: 50 },
      ],
    })
    expect(r.target).toEqual({ x: 78, y: 82 })
  })

  it('case 311', () => {
    const r = resolveArrowLabelPosition({
      ...HORIZONTAL,
      obstacles: [{ x: 70, y: 70, width: 60, height: 60 }], // (70-130, 70-130)
    })
    const labelBottom = r.target.y + r.height
    const labelTop = r.target.y
    expect(labelBottom <= 70 || labelTop >= 130).toBe(true)
  })

  it('case 312', () => {
    const r = resolveArrowLabelPosition({
      ...HORIZONTAL,
      obstacles: [{ x: -100, y: 0, width: 400, height: 100 }], // Covers everything above the horizontal line
    })
    expect(r.target.y).toBeGreaterThanOrEqual(100)
  })

  it('case 313', () => {
    const r = resolveArrowLabelPosition({
      ...HORIZONTAL,
      obstacles: [{ x: 60, y: -100, width: 80, height: 400 }], // Cuts vertically through the midpoint
    })
    const labelCenterX = r.target.x + r.width / 2
    expect(labelCenterX <= 60 || labelCenterX >= 140).toBe(true)
  })

  it('case 314', () => {
    const r = resolveArrowLabelPosition({
      ...HORIZONTAL,
      obstacles: [{ x: -10000, y: -10000, width: 20000, height: 20000 }],
    })
    expect(r.width).toBe(44)
    expect(r.height).toBe(24)
    expect(r.text).toBe('EDGE')
  })
})

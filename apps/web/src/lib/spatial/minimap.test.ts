// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fitMinimap, type MinimapBox, projectBox, unprojectPoint } from './minimap.js'

const box = (x: number, y: number, width: number, height: number): MinimapBox => ({
  x,
  y,
  width,
  height,
})

const SIZE = { width: 100, height: 100 }

describe('fitMinimap', () => {
  it('scales content down to fit inside the minimap, preserving aspect', () => {
    // 200x100 of content into a 100x100 box: the wider axis decides.
    const fit = fitMinimap([box(0, 0, 200, 100)], box(0, 0, 200, 100), SIZE, 0)
    expect(fit.scale).toBe(0.5)
  })

  it('centres the fitted content on the axis with slack', () => {
    const fit = fitMinimap([box(0, 0, 200, 100)], box(0, 0, 200, 100), SIZE, 0)
    // Content is 100 tall after scaling on x... no: 100 * 0.5 = 50, so 50
    // of vertical slack, half above.
    expect(projectBox(box(0, 0, 200, 100), fit)).toEqual({ x: 0, y: 25, width: 100, height: 50 })
  })

  it('never scales up — a tiny canvas stays its own size rather than filling the box', () => {
    // Magnifying two nodes to fill the minimap would make the overview lie
    // about how much room they occupy.
    const fit = fitMinimap([box(0, 0, 10, 10)], box(0, 0, 10, 10), SIZE, 0)
    expect(fit.scale).toBe(1)
  })

  it('includes the viewport in the fitted bounds, so panning off content still shows where you are', () => {
    // Content at the origin, viewport far to the right: a fit over content
    // alone would leave the viewport marker outside the minimap entirely.
    const fit = fitMinimap([box(0, 0, 100, 100)], box(900, 0, 100, 100), SIZE, 0)
    const viewport = projectBox(box(900, 0, 100, 100), fit)
    expect(viewport.x + viewport.width).toBeLessThanOrEqual(100)
    expect(viewport.x).toBeGreaterThanOrEqual(0)
  })

  it('keeps padding clear on every side', () => {
    const fit = fitMinimap([box(0, 0, 200, 200)], box(0, 0, 200, 200), SIZE, 10)
    const projected = projectBox(box(0, 0, 200, 200), fit)
    expect(projected).toEqual({ x: 10, y: 10, width: 80, height: 80 })
  })

  describe('totality', () => {
    it('handles an empty canvas by fitting the viewport alone', () => {
      const fit = fitMinimap([], box(0, 0, 200, 200), SIZE, 0)
      expect(fit.scale).toBe(0.5)
      expect(projectBox(box(0, 0, 200, 200), fit)).toEqual({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      })
    })

    it('skips a non-finite box instead of poisoning the whole fit', () => {
      const fit = fitMinimap(
        [{ x: Number.NaN, y: 0, width: 10, height: 10 }, box(0, 0, 200, 200)],
        box(0, 0, 200, 200),
        SIZE,
        0,
      )
      expect(fit.scale).toBe(0.5)
    })

    it('degrades to a usable fit when nothing has area', () => {
      const fit = fitMinimap([box(5, 5, 0, 0)], box(5, 5, 0, 0), SIZE, 0)
      expect(Number.isFinite(fit.scale)).toBe(true)
      expect(fit.scale).toBeGreaterThan(0)
      const projected = projectBox(box(5, 5, 0, 0), fit)
      expect(Number.isFinite(projected.x)).toBe(true)
      expect(Number.isFinite(projected.y)).toBe(true)
    })

    it('degrades when the minimap itself has no room', () => {
      const fit = fitMinimap([box(0, 0, 200, 200)], box(0, 0, 200, 200), { width: 0, height: 0 }, 0)
      expect(Number.isFinite(fit.scale)).toBe(true)
      expect(fit.scale).toBeGreaterThan(0)
    })

    it('treats padding larger than the box as no padding rather than inverting it', () => {
      const fit = fitMinimap([box(0, 0, 200, 200)], box(0, 0, 200, 200), SIZE, 80)
      expect(fit.scale).toBeGreaterThan(0)
      expect(Number.isFinite(fit.scale)).toBe(true)
    })
  })
})

describe('fitMinimap — derived spans that overflow', () => {
  // Every field below is finite; the DERIVED edge or span is not. Without a
  // check on the span itself, scale reaches 0 and unprojectPoint divides by
  // zero — so a press on the minimap would navigate to Infinity.
  it('survives a box whose far edge overflows to Infinity', () => {
    const overflowing = { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 10 }
    const fit = fitMinimap([overflowing], box(0, 0, 10, 10), SIZE, 0)
    expect(Number.isFinite(fit.scale)).toBe(true)
    expect(fit.scale).toBeGreaterThan(0)
  })

  it('survives two boxes at opposite numeric extremes', () => {
    const fit = fitMinimap(
      [box(-Number.MAX_VALUE, 0, 1, 1), box(Number.MAX_VALUE, 0, 1, 1)],
      box(0, 0, 10, 10),
      SIZE,
      0,
    )
    expect(Number.isFinite(fit.scale)).toBe(true)
    expect(fit.scale).toBeGreaterThan(0)
    const point = unprojectPoint({ x: 50, y: 50 }, fit)
    expect(Number.isFinite(point.x)).toBe(true)
    expect(Number.isFinite(point.y)).toBe(true)
  })
})

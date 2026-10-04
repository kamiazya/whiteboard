// @vitest-environment node
import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { indexNodeBoxes } from './geometry.js'
import {
  buildMinimapNodes,
  fitLargestRects,
  fitMinimap,
  type MinimapBox,
  projectBox,
  unprojectPoint,
} from './minimap.js'

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

function nodes(entries: SpatialCanvas['nodes']): SpatialCanvas['nodes'] {
  return entries
}

describe('buildMinimapNodes', () => {
  it('passes an authored hex color through unchanged', () => {
    const n = nodes([
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hi', color: '#ff0000' }),
    ])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
      { x: 0, y: 0, width: 100, height: 50, color: '#ff0000' },
    ])
  })

  it('resolves a preset key through the palette presets stroke', () => {
    const n = nodes([
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hi', color: '3' }),
    ])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
      { x: 0, y: 0, width: 100, height: 50, color: SPATIAL_LIGHT_PALETTE.presets['3'].stroke },
    ])
  })

  describe('with the workspace tag library', () => {
    const library: TagLibrary = {
      health: { values: { ok: { color: '4' }, failing: { color: '1' } } },
    }
    const tagged = nodes([
      textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'a', tags: ['health:ok'] }),
      textNode({
        id: 'b',
        x: 20,
        y: 0,
        width: 10,
        height: 10,
        text: 'b',
        tags: ['health:failing'],
        color: '#00ff00',
      }),
      textNode({ id: 'c', x: 40, y: 0, width: 10, height: 10, text: 'c', tags: ['plain'] }),
    ])
    const boxes = indexNodeBoxes({ nodes: tagged, edges: [] })

    it('draws a tagged node in the colour the library declares, as the board does', () => {
      const colours = buildMinimapNodes(tagged, boxes, SPATIAL_LIGHT_PALETTE, library).map(
        (entry) => entry.color,
      )
      // An authored colour wins over the declared one, and a tag the library
      // does not colour leaves the node on the overview's muted default.
      expect(colours).toEqual([SPATIAL_LIGHT_PALETTE.presets['4'].stroke, '#00ff00', undefined])
    })

    it('draws the same nodes by their own colour alone when no library is given', () => {
      expect(
        buildMinimapNodes(tagged, boxes, SPATIAL_LIGHT_PALETTE).map((entry) => entry.color),
      ).toEqual([undefined, '#00ff00', undefined])
    })
  })

  it('leaves an unstyled node with no color', () => {
    const n = nodes([textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hi' })])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
      { x: 0, y: 0, width: 100, height: 50, color: undefined },
    ])
  })

  it('maps every box, in order, over a mixed set of nodes', () => {
    const n = nodes([
      textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'a', color: '#00ff00' }),
      fileNode({ id: 'b', x: 20, y: 0, width: 10, height: 10, file: 'b.png' }),
      textNode({ id: 'c', x: 40, y: 0, width: 10, height: 10, text: 'c', color: '1' }),
    ])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
      { x: 0, y: 0, width: 10, height: 10, color: '#00ff00' },
      { x: 20, y: 0, width: 10, height: 10, color: undefined },
      { x: 40, y: 0, width: 10, height: 10, color: SPATIAL_LIGHT_PALETTE.presets['1'].stroke },
    ])
  })

  it("carries a node's own symbol, so the overview can say WHICH node a box is", () => {
    // The overview is exactly where a node is too small to read — which is
    // what `visual.symbol` was built for. Resolving it here keeps the
    // component free of facets, the same way colour already is.
    const n = nodes([
      textNode({
        id: 'a',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        text: 'hi',
        facets: { 'visual.symbol/v0': { kind: 'emoji', char: '📌' } },
      }),
    ])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)[0]?.symbol).toEqual({
      kind: 'emoji',
      char: '📌',
    })
  })

  it('leaves the symbol absent for a node that declares none', () => {
    const n = nodes([textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hi' })])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)[0]?.symbol).toBeUndefined()
  })
})

describe('fitLargestRects', () => {
  const rect = (x: number, y: number, w: number, h: number, color?: string) => ({
    x,
    y,
    w,
    h,
    color,
  })

  it('answers nothing for no rects', () => {
    expect(fitLargestRects([], 3, SIZE)).toEqual([])
  })

  it('keeps only the largest by area, largest first, and hands back each source', () => {
    const small = rect(0, 0, 10, 10, 'small')
    const big = rect(20, 0, 80, 80, 'big')
    const mid = rect(0, 50, 30, 30, 'mid')
    const kept = fitLargestRects([small, big, mid], 2, SIZE)
    expect(kept.map((k) => k.source)).toEqual([big, mid])
  })

  it('keeps everything when there are fewer rects than the limit', () => {
    const rects = [rect(0, 0, 10, 10), rect(20, 20, 10, 10)]
    expect(fitLargestRects(rects, 5, SIZE)).toHaveLength(2)
  })

  it('does not reorder or mutate its input', () => {
    const rects = [rect(0, 0, 1, 1), rect(0, 0, 9, 9), rect(0, 0, 4, 4)]
    const before = [...rects]
    fitLargestRects(rects, 2, SIZE)
    expect(rects).toEqual(before)
  })

  it('fits the kept rects inside the box, scaling down but never up', () => {
    const [only] = fitLargestRects([rect(0, 0, 400, 200)], 1, SIZE)
    expect(only?.box).toEqual({ x: 0, y: 25, width: 100, height: 50 })
    const [small] = fitLargestRects([rect(0, 0, 20, 10)], 1, SIZE)
    expect(small?.box.width).toBe(20)
    expect(small?.box.height).toBe(10)
  })

  it('fits the KEPT rects only, so a dropped outlier does not shrink the rest', () => {
    const near = [rect(0, 0, 50, 50), rect(50, 50, 50, 50)]
    const outlier = rect(10000, 10000, 1, 1)
    const without = fitLargestRects(near, 2, SIZE).map((k) => k.box)
    const withOutlier = fitLargestRects([...near, outlier], 2, SIZE).map((k) => k.box)
    expect(withOutlier).toEqual(without)
  })
})

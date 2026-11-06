// @vitest-environment node
import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { freehandLine } from './freehand.js'
import { indexNodeBoxes } from './geometry.js'
import {
  buildMinimap,
  fitLargestRects,
  fitMinimap,
  type MinimapBox,
  projectBox,
  projectStrokeSegments,
  strokeBounds,
  unprojectPoint,
} from './minimap.js'

const box = (x: number, y: number, width: number, height: number): MinimapBox => ({
  x,
  y,
  width,
  height,
})

const SIZE = { width: 100, height: 100 }

const minimapBoxesOf = (
  nodes: SpatialCanvas['nodes'],
  boxes: Parameters<typeof buildMinimap>[1],
  palette: Parameters<typeof buildMinimap>[2],
  tagLibrary?: TagLibrary,
) => buildMinimap({ nodes, edges: [] }, boxes, palette, tagLibrary).boxes

const minimapStrokesOf = (
  lines: SpatialCanvas['lines'],
  boxes: Parameters<typeof buildMinimap>[1],
  palette: Parameters<typeof buildMinimap>[2],
) =>
  buildMinimap({ nodes: [], edges: [], ...(lines === undefined ? {} : { lines }) }, boxes, palette)
    .strokes

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
    expect(minimapBoxesOf(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
      { x: 0, y: 0, width: 100, height: 50, color: '#ff0000' },
    ])
  })

  it('resolves a preset key through the palette presets stroke', () => {
    const n = nodes([
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hi', color: '3' }),
    ])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(minimapBoxesOf(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
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
      const colours = minimapBoxesOf(tagged, boxes, SPATIAL_LIGHT_PALETTE, library).map(
        (entry) => entry.color,
      )
      // An authored colour wins over the declared one, and a tag the library
      // does not colour leaves the node on the overview's muted default.
      expect(colours).toEqual([SPATIAL_LIGHT_PALETTE.presets['4'].stroke, '#00ff00', undefined])
    })

    it('draws the same nodes by their own colour alone when no library is given', () => {
      expect(
        minimapBoxesOf(tagged, boxes, SPATIAL_LIGHT_PALETTE).map((entry) => entry.color),
      ).toEqual([undefined, '#00ff00', undefined])
    })
  })

  it('leaves an unstyled node with no color', () => {
    const n = nodes([textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hi' })])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(minimapBoxesOf(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
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
    expect(minimapBoxesOf(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
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
    expect(minimapBoxesOf(n, boxes, SPATIAL_LIGHT_PALETTE)[0]?.symbol).toEqual({
      kind: 'emoji',
      char: '📌',
    })
  })

  it('leaves the symbol absent for a node that declares none', () => {
    const n = nodes([textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'hi' })])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(minimapBoxesOf(n, boxes, SPATIAL_LIGHT_PALETTE)[0]?.symbol).toBeUndefined()
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

describe('buildMinimapStrokes', () => {
  const pt = (x: number, y: number) => ({
    kind: 'point' as const,
    point: { x, y },
    end: 'none' as const,
  })
  const on = (node: string) => ({ kind: 'node' as const, node, end: 'none' as const })
  const n = nodes([textNode({ id: 'a', x: 100, y: 100, width: 100, height: 50, text: 'a' })])
  const boxes = indexNodeBoxes({ nodes: n, edges: [] })

  it('passes a free stroke through its ends and bends, in order, coloured by the palette', () => {
    const strokes = minimapStrokesOf(
      [{ id: 's', from: pt(0, 0), to: pt(40, 0), bends: [{ x: 20, y: 30 }], color: '3' }],
      boxes,
      SPATIAL_LIGHT_PALETTE,
    )
    expect(strokes).toEqual([
      {
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 30 },
          { x: 40, y: 0 },
        ],
        color: SPATIAL_LIGHT_PALETTE.presets['3'].stroke,
      },
    ])
  })

  it('stands an attached end at its node centre, and skips a line tied down at both ends', () => {
    const strokes = minimapStrokesOf(
      [
        { id: 'half', from: on('a'), to: pt(0, 0) },
        { id: 'tied', from: on('a'), to: on('a') },
      ],
      boxes,
      SPATIAL_LIGHT_PALETTE,
    )
    expect(strokes).toEqual([
      {
        points: [
          { x: 150, y: 125 },
          { x: 0, y: 0 },
        ],
      },
    ])
  })

  it('drops a line whose node has no box rather than inventing a place for it', () => {
    expect(
      minimapStrokesOf([{ id: 'x', from: on('gone'), to: pt(0, 0) }], boxes, SPATIAL_LIGHT_PALETTE),
    ).toEqual([])
  })

  it('answers nothing for a canvas with no lines collection', () => {
    expect(minimapStrokesOf(undefined, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([])
  })
})

describe('strokeBounds', () => {
  it('covers every point the stroke passes through', () => {
    expect(
      strokeBounds({
        points: [
          { x: 10, y: 5 },
          { x: -20, y: 40 },
          { x: 30, y: 0 },
        ],
      }),
    ).toEqual({ x: -20, y: 0, width: 50, height: 40 })
  })
})

describe('projectStrokeSegments', () => {
  const unit = { scale: 1, originX: 0, originY: 0 }

  it('answers one run per kept turn, each with its length and direction', () => {
    const [first, second] = projectStrokeSegments(
      {
        points: [
          { x: 0, y: 0 },
          { x: 30, y: 40 },
          { x: 30, y: 0 },
        ],
      },
      unit,
    )
    expect(first).toEqual({ x: 0, y: 0, length: 50, angle: Math.atan2(40, 30) })
    expect(second).toMatchObject({ x: 30, y: 40, length: 40 })
    expect(second?.angle).toBeCloseTo(-Math.PI / 2)
  })

  it('collapses samples along one straight run, keeping both ends', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ x: i * 10, y: 0 }))
    const segments = projectStrokeSegments({ points }, { scale: 0.05, originX: 0, originY: 0 })
    expect(segments).toHaveLength(1)
    expect(segments[0]?.length).toBeCloseTo(99 * 10 * 0.05)
  })

  it('keeps every sample within half an overview pixel of the drawn runs', () => {
    // A turn sharper than its samples are long: dropping the sample by
    // distance alone cuts the corner by over a pixel.
    const points = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 21, y: 1.5 },
      { x: 41, y: 1.5 },
      ...Array.from({ length: 40 }, (_, i) => {
        const t = (Math.PI * i) / 39
        return { x: 60 + 15 - 15 * Math.cos(t), y: 1.5 + 15 * Math.sin(t) }
      }),
    ]
    const segments = projectStrokeSegments({ points }, unit)
    for (const point of points) expect(distanceToRuns(point, segments)).toBeLessThanOrEqual(0.5)
    // An arc of 15px radius is several runs, not a chevron.
    expect(segments.length).toBeGreaterThanOrEqual(8)
  })

  it('caps how many runs one stroke can cost', () => {
    const points = Array.from({ length: 600 }, (_, i) => ({ x: i * 4, y: i % 2 === 0 ? 0 : 6 }))
    expect(projectStrokeSegments({ points }, unit).length).toBeLessThanOrEqual(64)
  })
})

/** How far `point` is from the nearest of `runs`, in the runs' own space. */
function distanceToRuns(
  point: { x: number; y: number },
  runs: ReturnType<typeof projectStrokeSegments>,
): number {
  return Math.min(
    ...runs.map((run) => {
      const dx = Math.cos(run.angle) * run.length
      const dy = Math.sin(run.angle) * run.length
      const t = Math.max(
        0,
        Math.min(1, ((point.x - run.x) * dx + (point.y - run.y) * dy) / (run.length ** 2 || 1)),
      )
      return Math.hypot(point.x - (run.x + t * dx), point.y - (run.y + t * dy))
    }),
  )
}

describe('a drawn stroke in the overview', () => {
  it('follows the curve the canvas draws through its samples, not their corners', () => {
    const line = freehandLine(
      'ink',
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 200, y: 0 },
      ],
      1,
    )
    if (line === undefined) throw new Error('no stroke')
    const [stroke] = buildMinimap(
      { nodes: [], edges: [], lines: [line] },
      [],
      SPATIAL_LIGHT_PALETTE,
    ).strokes
    const points = stroke?.points ?? []
    // The canvas rounds the sample at 100,100 into the quadratic its
    // neighbours' midpoints define, whose apex is 100,75.
    expect(points.some((p) => Math.abs(p.x - 100) < 1e-9 && Math.abs(p.y - 75) < 1e-9)).toBe(true)
    expect(points.some((p) => p.x === 100 && p.y === 100)).toBe(false)
    expect(points.length).toBeGreaterThan(5)
  })
})

// Calibration of the drawing score against KNOWN truths: a board with one
// planted defect reports exactly one. `drawing-quality.test.ts` is the
// scoreboard that pins the score over real diagrams; this file is what says
// the score can be believed there — an instrument trusted before it is
// calibrated is how `worstStallMs` reported 0.3ms for a 200ms stall.
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'
import { constantRatioMeasureText } from '../measure.js'
import type { Scene, SceneNode } from '../scene-graph.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { type DrawingScore, scoreDrawing } from './drawing-score.js'

// The measurer the lane and `wb_scene_render` fall back to, so a pin here
// and a `drawing` column there are the same number for the same board.
const measure = constantRatioMeasureText
const appearance = createSpatialTheme({ mode: 'light' })
const layout = (canvas: SpatialCanvas): Scene =>
  layoutSpatialCanvas(canvas, { measure, appearance })
const score = (canvas: SpatialCanvas): DrawingScore => scoreDrawing(canvas, layout(canvas))

const box = (id: string, x: number, y: number, width = 200, height = 80): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text: id,
})
const group = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  label = id,
): SpatialNode => ({ id, type: 'group', x, y, width, height, label })
const edge = (id: string, fromNode: string, toNode: string, label?: string): CanvasEdge =>
  label === undefined ? { id, fromNode, toNode } : { id, fromNode, toNode, label }
const canvasOf = (nodes: SpatialNode[], edges: CanvasEdge[] = []): SpatialCanvas => ({
  nodes,
  edges,
})

/** A scene drawn by hand, for the metrics that read edge paths and label boxes. */
const sceneOf = (...nodes: SceneNode[]): Scene => ({ nodes })
const pathEdge = (id: string, path: { x: number; y: number }[]): SceneNode => ({
  kind: 'edge',
  id,
  path,
  fromSide: 'right',
  toSide: 'left',
  fromEnd: 'none',
  toEnd: 'arrow',
})
const edgeLabel = (edgeId: string, x: number, y: number, w = 60, h = 16): SceneNode => ({
  kind: 'textRun',
  bbox: { x, y, w, h },
  text: edgeId,
  annotates: { kind: 'edge', id: edgeId },
})

const DEBT_FREE = {
  nodeOverlaps: 0,
  overlapAreaPx: 0,
  straddles: 0,
  edgeThroughNode: 0,
  throughInkPx: 0,
  labelOverNode: 0,
  labelOverLabel: 0,
  labelCovered: 0,
  textOverflow: 0,
  crampedMembers: 0,
  nearMisses: 0,
  tightGaps: 0,
  edgeThroughFrame: 0,
  edgeOverlaps: 0,
  sharedInkPx: 0,
}

describe('scoreDrawing: a clean board carries no debt', () => {
  it('two boxes a row apart, joined by one labelled edge', () => {
    const s = score(canvasOf([box('a', 0, 0), box('b', 400, 0)], [edge('e', 'a', 'b', 'calls')]))
    expect(s).toMatchObject({ ...DEBT_FREE, nodes: 2, edges: 1, crossings: 0, bends: 0 })
    expect(s.edgeLengthPx).toBe(200)
  })

  it('an empty canvas scores zero everywhere and an empty envelope', () => {
    expect(score(canvasOf([]))).toMatchObject({
      ...DEBT_FREE,
      nodes: 0,
      edges: 0,
      envelopePx: { w: 0, h: 0 },
      density: 0,
    })
  })
})

describe('scoreDrawing: node overlap', () => {
  it('counts one overlapping pair and its area', () => {
    const s = score(canvasOf([box('a', 0, 0), box('b', 150, 0)]))
    expect(s.nodeOverlaps).toBe(1)
    expect(s.overlapAreaPx).toBe(50 * 80)
  })

  it('a box wholly inside a group is containment, not overlap', () => {
    const s = score(canvasOf([group('g', 0, 0, 400, 300), box('a', 100, 100)]))
    expect(s.nodeOverlaps).toBe(0)
    expect(s.straddles).toBe(0)
  })

  it('a box half across a group frame straddles it', () => {
    const s = score(canvasOf([group('g', 0, 0, 400, 300), box('a', 300, 100)]))
    expect(s.straddles).toBe(1)
    expect(s.nodeOverlaps).toBe(0)
  })

  it('two group frames partially overlapping straddle each other once', () => {
    expect(
      score(canvasOf([group('g', 0, 0, 400, 300), group('h', 200, 0, 400, 300)])).straddles,
    ).toBe(1)
  })
})

describe('scoreDrawing: edges', () => {
  const nodes = [box('a', 0, 0), box('b', 400, 0), box('c', 800, 0)]

  it('an edge whose path runs through a box it does not touch is debt, measured in px', () => {
    const canvas = canvasOf(nodes, [edge('e', 'a', 'c')])
    const through = sceneOf(
      pathEdge('e', [
        { x: 200, y: 40 },
        { x: 800, y: 40 },
      ]),
    )
    const s = scoreDrawing(canvas, through)
    expect(s.edgeThroughNode).toBe(1)
    expect(s.throughInkPx).toBe(200)
  })

  it('an edge anchored strictly inside a box is not charged that box', () => {
    const canvas = canvasOf(nodes, [edge('e', 'a', 'b')])
    const s = scoreDrawing(
      canvas,
      sceneOf(
        pathEdge('e', [
          { x: 100, y: 40 },
          { x: 500, y: 40 },
        ]),
      ),
    )
    expect(s.edgeThroughNode).toBe(0)
  })

  it('an edge that leaves its source and comes back through it is charged its own box', () => {
    const canvas = canvasOf(nodes, [edge('e', 'a', 'b')])
    const s = scoreDrawing(
      canvas,
      sceneOf(
        pathEdge('e', [
          { x: 100, y: 80 },
          { x: 100, y: 120 },
          { x: 300, y: 120 },
          { x: 300, y: -40 },
          { x: 150, y: -40 },
          { x: 150, y: 40 },
          { x: 400, y: 40 },
        ]),
      ),
    )
    expect(s.edgeThroughNode).toBe(1)
    expect(s.throughInkPx).toBe(90)
  })

  it('an edge crossing a group frame it connects into is not counted', () => {
    const canvas = canvasOf(
      [group('g', 300, -100, 600, 300), box('a', 0, 0), box('b', 400, 0)],
      [edge('e', 'a', 'b')],
    )
    const s = score(canvas)
    expect(s.edgeThroughNode).toBe(0)
  })

  it('counts a proper crossing once and reports bends and length', () => {
    const canvas = canvasOf(nodes, [edge('e', 'a', 'c'), edge('f', 'b', 'b')])
    const s = scoreDrawing(
      canvas,
      sceneOf(
        pathEdge('e', [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
        ]),
        pathEdge('f', [
          { x: 50, y: 50 },
          { x: 150, y: 50 },
        ]),
      ),
    )
    expect(s.crossings).toBe(1)
    expect(s.bends).toBe(1)
    expect(s.edgeLengthPx).toBe(300)
  })

  it('the real router draws no crossing for two parallel edges between two rows', () => {
    const s = score(
      canvasOf(
        [box('a', 0, 0), box('b', 400, 0), box('c', 0, 300), box('d', 400, 300)],
        [edge('e', 'a', 'c'), edge('f', 'b', 'd')],
      ),
    )
    expect(s.crossings).toBe(0)
  })
})

describe('scoreDrawing: labels', () => {
  it('an edge label over a box is debt; over empty canvas it is not', () => {
    const canvas = canvasOf([box('a', 0, 0), box('b', 400, 0)], [edge('e', 'a', 'b', 'calls')])
    const over = scoreDrawing(canvas, sceneOf(edgeLabel('e', 100, 20)))
    const clear = scoreDrawing(canvas, sceneOf(edgeLabel('e', 250, 20)))
    expect(over.labelOverNode).toBe(1)
    expect(clear.labelOverNode).toBe(0)
  })

  it('two edge labels drawn on top of each other are one overlapping pair', () => {
    const canvas = canvasOf(
      [box('a', 0, 0), box('b', 400, 0)],
      [edge('e', 'a', 'b', 'x'), edge('f', 'a', 'b', 'y')],
    )
    const s = scoreDrawing(canvas, sceneOf(edgeLabel('e', 250, 20), edgeLabel('f', 260, 24)))
    expect(s.labelOverLabel).toBe(1)
  })

  it('a group label hidden under a box placed just above the frame is covered', () => {
    const covered = score(
      canvasOf([group('g', 0, 100, 400, 200, 'Clients'), box('a', 0, 60, 200, 40)]),
    )
    const free = score(
      canvasOf([group('g', 0, 100, 400, 200, 'Clients'), box('a', 0, -100, 200, 40)]),
    )
    expect(covered.labelCovered).toBe(1)
    expect(free.labelCovered).toBe(0)
  })

  it("a nested frame's label sits inside the frame that holds it, and is not covered", () => {
    // The outer frame is painted before the inner one, so the inner
    // frame's name drawn above it lies OVER the outer frame's fill, not
    // under anything. A box beside the inner frame, placed over its name,
    // still covers it.
    const nested = score(
      canvasOf([
        group('outer', 0, 0, 600, 400, 'Outer'),
        group('inner', 40, 80, 300, 200, 'Inner'),
      ]),
    )
    const covered = score(
      canvasOf([
        group('outer', 0, 0, 600, 400, 'Outer'),
        group('inner', 40, 80, 300, 200, 'Inner'),
        box('a', 40, 40, 200, 40),
      ]),
    )
    expect(nested.labelCovered).toBe(0)
    expect(covered.labelCovered).toBe(1)
  })
})

describe('scoreDrawing: fit and spacing', () => {
  it('a text node whose text does not fit its box overflows', () => {
    const cramped: SpatialNode = {
      id: 'a',
      type: 'text',
      x: 0,
      y: 0,
      width: 40,
      height: 24,
      text: 'a sentence far longer than forty pixels can hold on one line',
    }
    expect(score(canvasOf([cramped])).textOverflow).toBe(1)
    expect(score(canvasOf([box('a', 0, 0)])).textOverflow).toBe(0)
  })

  it('a member closer than the padding to its group frame is cramped', () => {
    expect(score(canvasOf([group('g', 0, 0, 400, 300), box('a', 4, 100)])).crampedMembers).toBe(1)
    expect(score(canvasOf([group('g', 0, 0, 400, 300), box('a', 24, 100)])).crampedMembers).toBe(0)
  })

  it('padding is judged against the innermost frame, not an outer one', () => {
    const s = score(
      canvasOf([
        group('outer', 0, 0, 800, 600),
        group('inner', 40, 40, 400, 300),
        box('a', 80, 100),
      ]),
    )
    expect(s.crampedMembers).toBe(0)
  })

  it('two boxes almost aligned on the left are one near miss; aligned or far apart, none', () => {
    expect(score(canvasOf([box('a', 0, 0), box('b', 10, 300)])).nearMisses).toBe(1)
    expect(score(canvasOf([box('a', 0, 0), box('b', 0, 300)])).nearMisses).toBe(0)
    expect(score(canvasOf([box('a', 0, 0), box('b', 100, 300)])).nearMisses).toBe(0)
  })

  it('two boxes almost aligned on the top are one near miss', () => {
    expect(score(canvasOf([box('a', 0, 0), box('b', 400, 6)])).nearMisses).toBe(1)
  })

  it('a group and its member are never a near miss of each other', () => {
    expect(score(canvasOf([group('g', 0, 0, 400, 300), box('a', 16, 16)])).nearMisses).toBe(0)
  })

  it('two neighbours on a row jammed closer than a readable gap are one tight gap; apart, none', () => {
    // 200 wide, so b at 208 leaves 8px; at 200 they touch; at 260 there is room.
    expect(score(canvasOf([box('a', 0, 0), box('b', 208, 0)])).tightGaps).toBe(1)
    expect(score(canvasOf([box('a', 0, 0), box('b', 200, 0)])).tightGaps).toBe(1)
    expect(score(canvasOf([box('a', 0, 0), box('b', 260, 0)])).tightGaps).toBe(0)
  })

  it('a column is judged the same way, and boxes that overlap are an overlap, not a tight gap', () => {
    expect(score(canvasOf([box('a', 0, 0), box('b', 0, 88)])).tightGaps).toBe(1)
    expect(score(canvasOf([box('a', 0, 0), box('b', 150, 0)])).tightGaps).toBe(0)
  })

  it('boxes close on one axis but not beside each other on the other keep no gap between them', () => {
    // b sits diagonally off a: 8px to the right of a's edge, but wholly below it.
    expect(score(canvasOf([box('a', 0, 0), box('b', 208, 300)])).tightGaps).toBe(0)
  })

  it('a group and its member are never a tight gap of each other', () => {
    expect(score(canvasOf([group('g', 0, 0, 400, 300), box('a', 4, 4)])).tightGaps).toBe(0)
  })

  it('a row whose gaps differ by more than a grid step has one uneven gap', () => {
    expect(score(canvasOf([box('a', 0, 0), box('b', 240, 0), box('c', 560, 0)])).unevenGaps).toBe(1)
    expect(score(canvasOf([box('a', 0, 0), box('b', 240, 0), box('c', 480, 0)])).unevenGaps).toBe(0)
  })

  it('a column is judged the same way', () => {
    expect(score(canvasOf([box('a', 0, 0), box('b', 0, 120), box('c', 0, 320)])).unevenGaps).toBe(1)
  })

  it('reports the envelope and how much of it is box', () => {
    const s = score(canvasOf([box('a', 0, 0), box('b', 200, 80)]))
    expect(s.envelopePx).toEqual({ w: 400, h: 160 })
    expect(s.density).toBe(0.5)
  })
})

describe('scoreDrawing: frames and edges (c-planarity)', () => {
  // Feng, Cohen & Eades (1995): an edge that belongs to no member of a
  // frame may not run through it. One that connects a member crosses the
  // boundary once, legitimately.
  const frameBoard = canvasOf(
    [group('g', 300, -100, 200, 300, 'Frame'), box('a', 0, 0), box('b', 600, 0)],
    [edge('e', 'a', 'b')],
  )

  it('an edge between two outsiders drawn through a frame is charged the frame', () => {
    const through = scoreDrawing(
      frameBoard,
      sceneOf(
        pathEdge('e', [
          { x: 200, y: 40 },
          { x: 600, y: 40 },
        ]),
      ),
    )
    const around = scoreDrawing(
      frameBoard,
      sceneOf(
        pathEdge('e', [
          { x: 200, y: 40 },
          { x: 250, y: 40 },
          { x: 250, y: 250 },
          { x: 550, y: 250 },
          { x: 550, y: 40 },
          { x: 600, y: 40 },
        ]),
      ),
    )
    expect(through.edgeThroughFrame).toBe(1)
    expect(around.edgeThroughFrame).toBe(0)
  })

  it('an edge into a member of the frame crosses its boundary once and is not charged', () => {
    const member = canvasOf(
      [group('g', 300, -100, 400, 300, 'Frame'), box('a', 0, 0), box('b', 400, 0)],
      [edge('e', 'a', 'b')],
    )
    const s = scoreDrawing(
      member,
      sceneOf(
        pathEdge('e', [
          { x: 200, y: 40 },
          { x: 400, y: 40 },
        ]),
      ),
    )
    expect(s.edgeThroughFrame).toBe(0)
  })
})

describe('scoreDrawing: edges over edges', () => {
  // Two edges along one line cannot be told apart; a touch at a point can.
  const twoEdges = canvasOf(
    [box('a', 0, 0), box('b', 400, 0), box('c', 0, 200), box('d', 400, 200)],
    [edge('e', 'a', 'b'), edge('f', 'c', 'd')],
  )

  it('two edges sharing a stretch of one line are one overlapping pair, measured in px', () => {
    const s = scoreDrawing(
      twoEdges,
      sceneOf(
        pathEdge('e', [
          { x: 200, y: 100 },
          { x: 400, y: 100 },
        ]),
        pathEdge('f', [
          { x: 300, y: 100 },
          { x: 600, y: 100 },
        ]),
      ),
    )
    expect(s.edgeOverlaps).toBe(1)
    expect(s.sharedInkPx).toBe(100)
  })

  it('edges that only touch end to end, run parallel apart, or cross share no ink', () => {
    const touching = scoreDrawing(
      twoEdges,
      sceneOf(
        pathEdge('e', [
          { x: 200, y: 100 },
          { x: 400, y: 100 },
        ]),
        pathEdge('f', [
          { x: 400, y: 100 },
          { x: 600, y: 100 },
        ]),
      ),
    )
    const crossing = scoreDrawing(
      twoEdges,
      sceneOf(
        pathEdge('e', [
          { x: 200, y: 100 },
          { x: 400, y: 100 },
        ]),
        pathEdge('f', [
          { x: 300, y: 0 },
          { x: 300, y: 200 },
        ]),
      ),
    )
    expect([touching.edgeOverlaps, touching.sharedInkPx]).toEqual([0, 0])
    expect([crossing.edgeOverlaps, crossing.sharedInkPx, crossing.crossings]).toEqual([0, 0, 1])
  })
})

describe('scoreDrawing: flow', () => {
  // Sugiyama (1981) and Burattin et al. (2016): a reader takes the flow
  // from where the boxes SIT, and an arrow whose head sits before its tail
  // along that flow is the one that reads backwards.
  const column = [box('a', 0, 0), box('b', 0, 200), box('c', 0, 400)]

  it('a chain down a column flows down, with nothing against it', () => {
    const s = score(canvasOf(column, [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')]))
    expect(s.flow).toBe('down')
    expect(s.againstFlow).toBe(0)
  })

  it('an arrow back up the column is against the flow', () => {
    const s = score(
      canvasOf(column, [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a')]),
    )
    expect(s.againstFlow).toBe(1)
  })

  it('an arrow between two boxes on one row, a few px apart, is beside the flow, not against it', () => {
    // `d` sits 10px lower than `b`, so its arrow to `b` points up by that
    // much: under the near-miss band, which is what "on one row" means.
    const s = score(
      canvasOf(
        [...column, box('d', 400, 210)],
        [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('db', 'd', 'b')],
      ),
    )
    expect(s.flow).toBe('down')
    expect(s.againstFlow).toBe(0)
  })

  it('a chain along a row flows right; a board with no edges has no flow', () => {
    const row = score(canvasOf([box('a', 0, 0), box('b', 400, 0)], [edge('ab', 'a', 'b')]))
    expect(row.flow).toBe('right')
    expect(score(canvasOf(column)).flow).toBe('none')
  })

  it('the arrowhead decides the direction, and an edge with none has no say', () => {
    const backwards = score(
      canvasOf(column, [
        { id: 'ab', fromNode: 'a', toNode: 'b', fromEnd: 'arrow', toEnd: 'none' },
        { id: 'bc', fromNode: 'b', toNode: 'c', fromEnd: 'arrow', toEnd: 'none' },
      ]),
    )
    const lines = score(
      canvasOf(column, [{ id: 'ab', fromNode: 'a', toNode: 'b', fromEnd: 'none', toEnd: 'none' }]),
    )
    const bothWays = score(
      canvasOf(column, [
        { id: 'ab', fromNode: 'a', toNode: 'b', fromEnd: 'arrow', toEnd: 'arrow' },
      ]),
    )
    expect(backwards.flow).toBe('up')
    expect(lines.flow).toBe('none')
    expect(bothWays.flow).toBe('none')
  })
})

describe('scoreDrawing: continuity and rates', () => {
  it('a path that doubles back on an axis is one reversal; an L is none', () => {
    const canvas = canvasOf([box('a', 0, 0), box('b', 400, 0)], [edge('e', 'a', 'b')])
    const doubled = scoreDrawing(
      canvas,
      sceneOf(
        pathEdge('e', [
          { x: 100, y: 80 },
          { x: 100, y: 140 },
          { x: 500, y: 140 },
          { x: 500, y: 80 },
        ]),
      ),
    )
    const elbow = scoreDrawing(
      canvas,
      sceneOf(
        pathEdge('e', [
          { x: 100, y: 80 },
          { x: 100, y: 140 },
          { x: 400, y: 140 },
        ]),
      ),
    )
    expect(doubled.reversals).toBe(1)
    expect(elbow.reversals).toBe(0)
  })

  it('reports crossings and bends per edge, and overlaps per pair of boxes', () => {
    const canvas = canvasOf(
      [box('a', 0, 0), box('b', 400, 0), box('c', 0, 200), box('d', 150, 200)],
      [edge('e', 'a', 'b'), edge('f', 'c', 'd')],
    )
    const s = scoreDrawing(
      canvas,
      sceneOf(
        pathEdge('e', [
          { x: 200, y: 40 },
          { x: 300, y: 40 },
          { x: 300, y: 240 },
          { x: 350, y: 240 },
        ]),
        pathEdge('f', [
          { x: 250, y: 300 },
          { x: 250, y: 0 },
        ]),
      ),
    )
    expect(s.crossingsPerEdge).toBe(0.5)
    expect(s.bendsPerEdge).toBe(1)
    // Four boxes make six pairs; `c` and `d` overlap by 50px.
    expect(s.overlapsPerPair).toBe(0.17)
  })

  it('a board with no edges or one box reports zero rates, not NaN', () => {
    const s = score(canvasOf([box('a', 0, 0)]))
    expect([s.crossingsPerEdge, s.bendsPerEdge, s.overlapsPerPair]).toEqual([0, 0, 0])
  })
})

// Each planted defect moves the column that names it and no other debt
// column, so a reader of a lane result can trust that a non-zero names ONE
// mistake. The price columns are free to move: an overlap changes density.
describe('scoreDrawing: one planted defect moves one debt column', () => {
  type Debt = keyof typeof DEBT_FREE
  const DEBT_COLUMNS = Object.keys(DEBT_FREE) as Debt[]
  const moved = (base: DrawingScore, planted: DrawingScore): Debt[] =>
    DEBT_COLUMNS.filter((c) => base[c] !== planted[c])

  const straight = (from: number, to: number, y: number) =>
    pathEdge('e', [
      { x: from, y },
      { x: to, y },
    ])
  const twoBoxes = canvasOf([box('a', 0, 0), box('b', 400, 0)], [edge('e', 'a', 'b', 'calls')])
  const threeInRow = canvasOf(
    [box('a', 0, 0), box('c', 300, 0), box('b', 600, 0)],
    [edge('e', 'a', 'b')],
  )
  const frameApart = canvasOf(
    [group('g', 300, -100, 200, 300, 'Frame'), box('a', 0, 0), box('b', 600, 0)],
    [edge('e', 'a', 'b')],
  )
  const twoEdges = canvasOf(
    [box('a', 0, 0), box('b', 400, 0), box('c', 0, 200), box('d', 400, 200)],
    [edge('e', 'a', 'b'), edge('f', 'c', 'd')],
  )
  const overflowing: SpatialNode = {
    id: 'a',
    type: 'text',
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    text: 'a sentence that cannot fit in a box this small',
  }

  it.each<[string, DrawingScore, DrawingScore, Debt[]]>([
    [
      'a box over another',
      score(canvasOf([box('a', 0, 0), box('b', 400, 0)])),
      score(canvasOf([box('a', 0, 0), box('b', 150, 0)])),
      ['nodeOverlaps', 'overlapAreaPx'],
    ],
    [
      'a box across a frame',
      score(canvasOf([group('g', 0, 0, 400, 300), box('a', 100, 100)])),
      score(canvasOf([group('g', 0, 0, 400, 300), box('a', 300, 100)])),
      ['straddles'],
    ],
    [
      'a member against its frame',
      score(canvasOf([group('g', 0, 0, 400, 300), box('a', 100, 100)])),
      score(canvasOf([group('g', 0, 0, 400, 300), box('a', 8, 100)])),
      ['crampedMembers'],
    ],
    [
      'a box a few pixels off its row',
      score(canvasOf([box('a', 0, 0), box('b', 400, 0)])),
      score(canvasOf([box('a', 0, 0), box('b', 400, 10)])),
      ['nearMisses'],
    ],
    [
      'a box jammed against its neighbour',
      score(canvasOf([box('a', 0, 0), box('b', 400, 0)])),
      score(canvasOf([box('a', 0, 0), box('b', 208, 0)])),
      ['tightGaps'],
    ],
    [
      "a box over a frame's name",
      score(canvasOf([group('g', 0, 100, 400, 200, 'Clients'), box('a', 0, -100, 200, 40)])),
      score(canvasOf([group('g', 0, 100, 400, 200, 'Clients'), box('a', 0, 60, 200, 40)])),
      ['labelCovered'],
    ],
    [
      'text that does not fit',
      score(canvasOf([box('a', 0, 0)])),
      score(canvasOf([overflowing])),
      ['textOverflow'],
    ],
    [
      'an edge through a box',
      scoreDrawing(
        threeInRow,
        sceneOf(
          pathEdge('e', [
            { x: 100, y: 80 },
            { x: 100, y: 200 },
            { x: 700, y: 200 },
            { x: 700, y: 80 },
          ]),
        ),
      ),
      scoreDrawing(threeInRow, sceneOf(straight(200, 600, 40))),
      ['edgeThroughNode', 'throughInkPx'],
    ],
    [
      'an edge through a frame',
      scoreDrawing(
        frameApart,
        sceneOf(
          pathEdge('e', [
            { x: 200, y: 40 },
            { x: 200, y: 250 },
            { x: 600, y: 250 },
            { x: 600, y: 80 },
          ]),
        ),
      ),
      scoreDrawing(frameApart, sceneOf(straight(200, 600, 40))),
      ['edgeThroughFrame'],
    ],
    [
      'an edge along another',
      scoreDrawing(
        twoEdges,
        sceneOf(
          straight(200, 400, 100),
          pathEdge('f', [
            { x: 400, y: 100 },
            { x: 600, y: 100 },
          ]),
        ),
      ),
      scoreDrawing(
        twoEdges,
        sceneOf(
          straight(200, 400, 100),
          pathEdge('f', [
            { x: 300, y: 100 },
            { x: 600, y: 100 },
          ]),
        ),
      ),
      ['edgeOverlaps', 'sharedInkPx'],
    ],
    [
      'an edge label over a box',
      scoreDrawing(twoBoxes, sceneOf(edgeLabel('e', 250, 20))),
      scoreDrawing(twoBoxes, sceneOf(edgeLabel('e', 50, 20))),
      ['labelOverNode'],
    ],
    [
      'an edge label over another',
      scoreDrawing(
        canvasOf(
          [box('a', 0, 0), box('b', 400, 0)],
          [edge('e', 'a', 'b', 'x'), edge('f', 'a', 'b', 'y')],
        ),
        sceneOf(edgeLabel('e', 250, 20), edgeLabel('f', 250, 60)),
      ),
      scoreDrawing(
        canvasOf(
          [box('a', 0, 0), box('b', 400, 0)],
          [edge('e', 'a', 'b', 'x'), edge('f', 'a', 'b', 'y')],
        ),
        sceneOf(edgeLabel('e', 250, 20), edgeLabel('f', 260, 24)),
      ),
      ['labelOverLabel'],
    ],
  ])('%s moves only its own column', (_name, base, planted, columns) => {
    expect(base).toMatchObject(DEBT_FREE)
    expect(moved(base, planted).sort()).toEqual([...columns].sort())
  })
})

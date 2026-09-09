// Calibration of the drawing score against KNOWN truths: a board with one
// planted defect reports exactly one. `drawing-quality.test.ts` is the
// scoreboard that pins the score over real diagrams; this file is what says
// the score can be believed there — an instrument trusted before it is
// calibrated is how `worstStallMs` reported 0.3ms for a 200ms stall.
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'
import type { Scene, SceneNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { type DrawingScore, scoreDrawing } from './drawing-score.js'

const measure = createFakeMeasure()
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

  it('an edge inside its own endpoints is not counted', () => {
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

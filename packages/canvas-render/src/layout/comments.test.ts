// The comment annotation layer's rendering (ADR-0024 decision 4): pins and
// bubbles composed into the SVG scene AFTER nodes and edges, so they paint
// above content on every surface — widget, viewer, export — with no per-
// surface wiring. Placement floats near the anchor; nothing here is stored.

import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { CommentThread, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import type {
  BoundingBox,
  ResolvedEdgeNode,
  SceneNode,
  ShapeSceneNode,
  TextRunNode,
} from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { MARKDOWN_THEME_NODE } from '../theme/markdown-theme.js'
import type { SpatialAppearanceResolver } from './nodes/spatial-appearance.js'
import {
  COMMENT_BUBBLE_OFFSET_PX,
  COMMENT_PIN_SIZE_PX,
  layoutSpatialCanvas,
  type SpatialLayoutOptions,
} from './spatial-canvas.js'

const measure = createFakeMeasure()

const fakeAppearance: SpatialAppearanceResolver = {
  resolveNode: () => ({ radius: 4 }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
  resolveComment: () => ({
    pin: { fill: '#d97706' },
    bubble: { fill: '#fef3c7', stroke: '#d97706' },
    leader: { stroke: '#d97706', strokeWidth: 1, strokeDasharray: '4 3' },
    passage: { fill: '#d97706', fillOpacity: 0.22 },
    region: { fill: 'none', stroke: '#d97706', strokeWidth: 1.5, strokeDasharray: '6 4' },
    pinCount: { fill: '#fef3c7', fontFamily: 'sans-serif' },
    resolvedOverlay: {
      pin: { fill: '#d97706', fillOpacity: 0.45 },
      bubble: { fill: '#fef3c7', stroke: '#d97706', fillOpacity: 0.45 },
      leader: { stroke: '#d97706', strokeWidth: 1, strokeDasharray: '4 3', strokeOpacity: 0.45 },
      passage: { fill: '#d97706', fillOpacity: 0.1 },
      region: {
        fill: 'none',
        stroke: '#d97706',
        strokeWidth: 1.5,
        strokeDasharray: '6 4',
        strokeOpacity: 0.45,
      },
      pinCount: { fill: '#fef3c7', fontFamily: 'sans-serif', fillOpacity: 0.45 },
    },
  }),
}

function fakeParseBody(text: string): MdastRoot {
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }
}

function baseOptions(overrides: Partial<SpatialLayoutOptions> = {}): SpatialLayoutOptions {
  return {
    measure,
    parseBody: fakeParseBody,
    appearance: fakeAppearance,
    geometry: { paddingPx: 8, labelFontSizePx: 14, minContentWidthPx: 1 },
    ...overrides,
  }
}

const TEXT_NODE: SpatialNode = {
  id: 'n1',
  type: 'text',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  text: 'content',
}

function canvasWith(comments: NonNullable<SpatialCanvas['x-whiteboard']>['comments']) {
  return {
    nodes: [TEXT_NODE],
    edges: [],
    'x-whiteboard': { comments },
  } satisfies SpatialCanvas
}

function shapesOf(nodes: readonly SceneNode[]): ShapeSceneNode[] {
  return nodes.filter((node): node is ShapeSceneNode => node.kind === 'shape')
}

// The handle the editor's hit-testing consumes: `${comment.id}/pin` and
// `${comment.id}/bubble`, mirroring the shipped `${comment.id}/leader`
// convention.
function pinOf(nodes: readonly SceneNode[], commentId: string): ShapeSceneNode | undefined {
  return shapesOf(nodes).find((shape) => shape.id === `${commentId}/pin`)
}

function bubbleOf(nodes: readonly SceneNode[], commentId: string): ShapeSceneNode | undefined {
  return shapesOf(nodes).find((shape) => shape.id === `${commentId}/bubble`)
}

// Comment text lays out through the mdast pipeline, so its runs sit inside
// paragraph/heading BLOCK nodes rather than at the top level.
function runsOf(nodes: readonly SceneNode[]): TextRunNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'textRun') return [node]
    if (node.kind === 'paragraph' || node.kind === 'heading') return [...node.runs]
    return []
  })
}

describe('the comments option', () => {
  // ADR-0026 decision 1b: the annotation layer is keeper-side, so it stops
  // riding inside the canvas envelope and travels beside it. These pin the
  // seam that lets a caller hand comments over directly — the step that
  // makes a markdown document's threads renderable at all, since it has no
  // envelope to put them in.
  it('draws comments passed as an option, on a canvas whose envelope has none', () => {
    const scene = layoutSpatialCanvas(
      { nodes: [TEXT_NODE], edges: [] },
      baseOptions({ comments: [{ id: 'c1', x: 400, y: 60, text: 'from beside the canvas' }] }),
    )

    expect(pinOf(scene.nodes, 'c1')).toBeDefined()
    // Joined, because the body lays out through the markdown pipeline and a
    // bubble-width wrap splits it across runs.
    expect(
      runsOf(scene.nodes)
        .map((run) => run.text)
        .join(' '),
    ).toContain('from beside the canvas')
  })

  it('lets the option win over the envelope, so a migrating caller is never doubled', () => {
    // Both populated is what a half-migrated call site looks like. Drawing
    // the union would put two pins on one comment; preferring the argument
    // makes the migration one call site at a time.
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'stale', x: 10, y: 10, text: 'from the envelope' }]),
      baseOptions({ comments: [{ id: 'fresh', x: 400, y: 60, text: 'from the option' }] }),
    )

    expect(pinOf(scene.nodes, 'fresh')).toBeDefined()
    expect(pinOf(scene.nodes, 'stale')).toBeUndefined()
  })

  it('draws nothing for an empty option, rather than falling back to the envelope', () => {
    // An empty array is an ANSWER — "this document has no conversations" —
    // and a caller that has read the layer and found it empty must not get
    // the envelope's stale copy back.
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'stale', x: 10, y: 10, text: 'from the envelope' }]),
      baseOptions({ comments: [] }),
    )

    expect(pinOf(scene.nodes, 'stale')).toBeUndefined()
  })
})

describe('comment layer', () => {
  it('draws a pin centered on the anchor and a bubble holding the text, after all content', () => {
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 400, y: 60, text: 'move this left' }]),
      baseOptions(),
    )

    const pin = pinOf(scene.nodes, 'c1')
    expect(pin).toBeDefined()
    expect(pin?.commentChrome).toBe(true)
    expect(pin?.bbox.x).toBe(400 - COMMENT_PIN_SIZE_PX / 2)
    expect(pin?.bbox.y).toBe(60 - COMMENT_PIN_SIZE_PX / 2)
    // A circle: the rect chrome with radius = half its side.
    expect(pin?.radius).toBe(COMMENT_PIN_SIZE_PX / 2)
    expect(pin?.appearance).toEqual({ fill: '#d97706' })

    const bubble = bubbleOf(scene.nodes, 'c1')
    expect(bubble).toBeDefined()
    expect(bubble?.commentChrome).toBe(true)
    expect(bubble?.bbox.x).toBe(400 + COMMENT_BUBBLE_OFFSET_PX)
    expect(bubble?.bbox.y).toBe(60 + COMMENT_BUBBLE_OFFSET_PX)

    const texts = runsOf(scene.nodes).map((run) => run.text)
    expect(texts).toContain('move this left')

    // Painted ABOVE everything: the pin and bubble come after the node's own
    // scene entries in the flat paint list.
    const nodeChromeIndex = scene.nodes.findIndex(
      (node) => node.kind === 'shape' && node.id === 'n1',
    )
    const pinIndex = scene.nodes.indexOf(pin as ShapeSceneNode)
    expect(pinIndex).toBeGreaterThan(nodeChromeIndex)
  })

  it('ties pin to bubble with a dashed leader line drawn under both', () => {
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 400, y: 60, text: 'move this left' }]),
      baseOptions(),
    )
    const leader = scene.nodes.find(
      (node): node is ResolvedEdgeNode => node.kind === 'edge' && node.id === 'c1/leader',
    )
    expect(leader).toBeDefined()
    // From the anchor (the pin's center) to the bubble's near corner, so the
    // relation still reads when a dense canvas separates the two. The end
    // lands ON the rounded corner's arc (radius 8), not the bbox corner,
    // which sits outside the rounded fill and would leave a gap.
    const inset = 8 * (1 - Math.SQRT1_2)
    expect(leader?.path).toEqual([
      { x: 400, y: 60 },
      { x: 400 + COMMENT_BUBBLE_OFFSET_PX + inset, y: 60 + COMMENT_BUBBLE_OFFSET_PX + inset },
    ])
    expect(leader?.fromEnd).toBe('none')
    expect(leader?.toEnd).toBe('none')
    expect(leader?.appearance).toEqual({
      stroke: '#d97706',
      strokeWidth: 1,
      strokeDasharray: '4 3',
    })

    // Under the pin and bubble: both ends tuck beneath the chrome instead of
    // striking through it.
    const pin = pinOf(scene.nodes, 'c1')
    const bubble = bubbleOf(scene.nodes, 'c1')
    const leaderIndex = scene.nodes.indexOf(leader as ResolvedEdgeNode)
    expect(leaderIndex).toBeLessThan(scene.nodes.indexOf(pin as ShapeSceneNode))
    expect(leaderIndex).toBeLessThan(scene.nodes.indexOf(bubble as ShapeSceneNode))
  })

  it('a bare resolver still gets the leader geometry, carrying no appearance', () => {
    const bare: SpatialAppearanceResolver = {
      resolveNode: () => ({}),
      resolveEdge: () => undefined,
      resolveLabel: () => ({}),
    }
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 5, y: 5, text: 'still tied' }]),
      baseOptions({ appearance: bare }),
    )
    const leader = scene.nodes.find(
      (node): node is ResolvedEdgeNode => node.kind === 'edge' && node.id === 'c1/leader',
    )
    expect(leader).toBeDefined()
    expect(leader?.appearance).toBeUndefined()
  })

  it('follows the target node when it resolves, and falls back to the anchor when it is gone', () => {
    const followed = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 999, y: 999, text: 'about n1', targetNodeId: 'n1' }]),
      baseOptions(),
    )
    const followedPin = pinOf(followed.nodes, 'c1')
    // Pinned to the node's top-right corner, not the stored anchor.
    expect(followedPin?.bbox.x).toBe(200 - COMMENT_PIN_SIZE_PX / 2)
    expect(followedPin?.bbox.y).toBe(0 - COMMENT_PIN_SIZE_PX / 2)

    const dangling = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 50, y: 70, text: 'about a deleted node', targetNodeId: 'gone' }]),
      baseOptions(),
    )
    const danglingPin = pinOf(dangling.nodes, 'c1')
    expect(danglingPin?.bbox.x).toBe(50 - COMMENT_PIN_SIZE_PX / 2)
    expect(danglingPin?.bbox.y).toBe(70 - COMMENT_PIN_SIZE_PX / 2)
  })

  it('rides the target edge: pinned on its routed path, at the point nearest the stored anchor', () => {
    // Two nodes side by side, so the edge between them is a straight line
    // at their shared centre height; the comment is stored well below it.
    const left: SpatialNode = {
      id: 'a',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      text: 'a',
    }
    const right: SpatialNode = {
      id: 'b',
      type: 'text',
      x: 400,
      y: 0,
      width: 100,
      height: 100,
      text: 'b',
    }
    const canvas: SpatialCanvas = {
      nodes: [left, right],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
      'x-whiteboard': {
        comments: [{ id: 'c1', x: 250, y: 130, text: 'this link', targetEdgeId: 'e1' }],
      },
    }
    const scene = layoutSpatialCanvas(canvas, baseOptions())
    const edge = scene.nodes.find(
      (node): node is ResolvedEdgeNode => node.kind === 'edge' && node.id === 'e1',
    )
    const ys = new Set((edge?.path ?? []).map((point) => point.y))
    expect(ys.size).toBe(1)
    const [edgeY] = ys
    const pin = pinOf(scene.nodes, 'c1')
    expect(pin?.bbox.y).toBe((edgeY as number) - COMMENT_PIN_SIZE_PX / 2)
    expect(pin?.bbox.x).toBe(250 - COMMENT_PIN_SIZE_PX / 2)

    // The edge gone, the comment stands where it was stored — orphaned in
    // the panel, never dropped from the canvas.
    const dangling = layoutSpatialCanvas({ ...canvas, edges: [] }, baseOptions())
    expect(pinOf(dangling.nodes, 'c1')?.bbox.y).toBe(130 - COMMENT_PIN_SIZE_PX / 2)
  })

  it('does not draw a resolved comment — the record stays in the document, not on the canvas', () => {
    const withoutComments = layoutSpatialCanvas({ nodes: [TEXT_NODE], edges: [] }, baseOptions())
    const withResolved = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 10, y: 10, text: 'done already', resolved: true }]),
      baseOptions(),
    )
    expect(withResolved).toEqual(withoutComments)
  })

  it('a canvas without comments lays out exactly as before the layer existed', () => {
    const plain = layoutSpatialCanvas({ nodes: [TEXT_NODE], edges: [] }, baseOptions())
    const explicitEmpty = layoutSpatialCanvas(canvasWith([]), baseOptions())
    expect(explicitEmpty).toEqual(plain)
  })

  it('renders pins without appearance when the resolver does not know comments', () => {
    // A resolver predating the layer (or a caller's custom one) must not
    // break layout — appearance is assigned, never invented, so the pins
    // simply carry none.
    const bare: SpatialAppearanceResolver = {
      resolveNode: () => ({}),
      resolveEdge: () => undefined,
      resolveLabel: () => ({}),
    }
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 5, y: 5, text: 'still drawn' }]),
      baseOptions({ appearance: bare }),
    )
    const pin = pinOf(scene.nodes, 'c1')
    expect(pin).toBeDefined()
    expect(pin?.commentChrome).toBe(true)
    expect(pin?.appearance).toBeUndefined()
    expect(runsOf(scene.nodes).map((run) => run.text)).toContain('still drawn')
  })

  it('draws a resolved comment muted, with ids, when showResolved is on — unresolved stays base', () => {
    const scene = layoutSpatialCanvas(
      canvasWith([
        { id: 'c1', x: 10, y: 10, text: 'still open' },
        { id: 'c2', x: 400, y: 60, text: 'done already', resolved: true },
      ]),
      baseOptions({ showResolved: true }),
    )

    const openPin = pinOf(scene.nodes, 'c1')
    expect(openPin?.appearance).toEqual({ fill: '#d97706' })

    const resolvedPin = pinOf(scene.nodes, 'c2')
    const resolvedBubble = bubbleOf(scene.nodes, 'c2')
    expect(resolvedPin).toBeDefined()
    expect(resolvedPin?.commentChrome).toBe(true)
    expect(resolvedBubble).toBeDefined()
    expect(resolvedBubble?.commentChrome).toBe(true)
    expect(resolvedPin?.appearance).toEqual({ fill: '#d97706', fillOpacity: 0.45 })
    expect(resolvedBubble?.appearance).toEqual({
      fill: '#fef3c7',
      stroke: '#d97706',
      fillOpacity: 0.45,
    })

    const resolvedLeader = scene.nodes.find(
      (node): node is ResolvedEdgeNode => node.kind === 'edge' && node.id === 'c2/leader',
    )
    expect(resolvedLeader?.appearance).toEqual({
      stroke: '#d97706',
      strokeWidth: 1,
      strokeDasharray: '4 3',
      strokeOpacity: 0.45,
    })

    const texts = runsOf(scene.nodes).map((run) => run.text)
    expect(texts).toContain('done already')
  })

  it('showResolved absent/false is byte-identical to before it existed — a resolved comment stays hidden', () => {
    const withoutFlag = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 10, y: 10, text: 'done already', resolved: true }]),
      baseOptions(),
    )
    const withFlagOff = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 10, y: 10, text: 'done already', resolved: true }]),
      baseOptions({ showResolved: false }),
    )
    expect(withFlagOff).toEqual(withoutFlag)
  })

  it('a bare resolver composes a resolved comment under showResolved too, carrying no appearance', () => {
    const bare: SpatialAppearanceResolver = {
      resolveNode: () => ({}),
      resolveEdge: () => undefined,
      resolveLabel: () => ({}),
    }
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 5, y: 5, text: 'done, no theme', resolved: true }]),
      baseOptions({ appearance: bare, showResolved: true }),
    )
    const pin = pinOf(scene.nodes, 'c1')
    const bubble = bubbleOf(scene.nodes, 'c1')
    expect(pin).toBeDefined()
    expect(pin?.appearance).toBeUndefined()
    expect(bubble).toBeDefined()
    expect(bubble?.appearance).toBeUndefined()
    expect(runsOf(scene.nodes).map((run) => run.text)).toContain('done, no theme')
  })

  it('wraps long comment text within the bubble width instead of one endless line', () => {
    const scene = layoutSpatialCanvas(
      canvasWith([
        {
          id: 'c1',
          x: 0,
          y: 0,
          text: 'a fairly long comment that certainly cannot fit on one narrow bubble line',
        },
      ]),
      baseOptions(),
    )
    const runs = runsOf(scene.nodes).filter((run) => run.text !== 'content')
    expect(runs.length).toBeGreaterThan(1)
  })

  describe('placement', () => {
    const NEIGHBOUR: SpatialNode = {
      id: 'n2',
      type: 'text',
      x: 214,
      y: 20,
      width: 200,
      height: 100,
      text: 'neighbour',
    }
    function bboxOverlap(a: BoundingBox, b: BoundingBox): number {
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      return w > 0 && h > 0 ? w * h : 0
    }

    it('a node-anchored bubble does not cover the node to its right', () => {
      const scene = layoutSpatialCanvas(
        {
          nodes: [TEXT_NODE, NEIGHBOUR],
          edges: [],
          'x-whiteboard': {
            comments: [{ id: 'c1', x: 0, y: 0, text: 'tighten', targetNodeId: 'n1' }],
          },
        },
        baseOptions(),
      )
      const bubble = bubbleOf(scene.nodes, 'c1') as ShapeSceneNode
      expect(bboxOverlap(bubble.bbox, { x: 214, y: 20, w: 200, h: 100 })).toBe(0)
      expect(bboxOverlap(bubble.bbox, { x: 0, y: 0, w: 200, h: 100 })).toBe(0)
      // Up-right of the anchor (200, 0): the leader ends on the bubble's
      // bottom-left corner arc, the corner nearest the pin.
      expect(bubble.bbox.y + bubble.bbox.h).toBe(0 - COMMENT_BUBBLE_OFFSET_PX)
      const leader = scene.nodes.find(
        (node): node is ResolvedEdgeNode => node.kind === 'edge' && node.id === 'c1/leader',
      )
      const inset = 8 * (1 - Math.SQRT1_2)
      expect(leader?.path[1]).toEqual({
        x: bubble.bbox.x + inset,
        y: bubble.bbox.y + bubble.bbox.h - inset,
      })
    })

    it('a later comment fans out around an earlier bubble instead of stacking on it', () => {
      const scene = layoutSpatialCanvas(
        canvasWith([
          { id: 'c1', x: 400, y: 300, text: 'first' },
          { id: 'c2', x: 406, y: 304, text: 'second' },
        ]),
        baseOptions(),
      )
      const first = bubbleOf(scene.nodes, 'c1') as ShapeSceneNode
      const second = bubbleOf(scene.nodes, 'c2') as ShapeSceneNode
      expect(bboxOverlap(first.bbox, second.bbox)).toBe(0)
      // The earlier one keeps its default spot: document order decides who yields.
      expect(first.bbox.x).toBe(400 + COMMENT_BUBBLE_OFFSET_PX)
      expect(first.bbox.y).toBe(300 + COMMENT_BUBBLE_OFFSET_PX)
    })

    it('a bubble pushed to the left is led to by its right-hand corner', () => {
      // A wall to the right of the anchor takes both right-hand quadrants.
      const scene = layoutSpatialCanvas(
        {
          nodes: [
            { id: 'wall', type: 'text', x: 405, y: -500, width: 400, height: 1000, text: 'w' },
          ],
          edges: [],
          'x-whiteboard': { comments: [{ id: 'c1', x: 400, y: 300, text: 'left' }] },
        },
        baseOptions(),
      )
      const bubble = bubbleOf(scene.nodes, 'c1') as ShapeSceneNode
      expect(bubble.bbox.x + bubble.bbox.w).toBe(400 - COMMENT_BUBBLE_OFFSET_PX)
      expect(bubble.bbox.y).toBe(300 + COMMENT_BUBBLE_OFFSET_PX)
      const leader = scene.nodes.find(
        (node): node is ResolvedEdgeNode => node.kind === 'edge' && node.id === 'c1/leader',
      )
      const inset = 8 * (1 - Math.SQRT1_2)
      expect(leader?.path[1]).toEqual({
        x: bubble.bbox.x + bubble.bbox.w - inset,
        y: bubble.bbox.y + inset,
      })
    })

    it('a group frame is not an obstacle, so a comment inside a group stays inside it', () => {
      const scene = layoutSpatialCanvas(
        {
          nodes: [{ id: 'g', type: 'group', x: 0, y: 0, width: 800, height: 800 }],
          edges: [],
          'x-whiteboard': { comments: [{ id: 'c1', x: 100, y: 100, text: 'in the frame' }] },
        },
        baseOptions(),
      )
      const bubble = bubbleOf(scene.nodes, 'c1') as ShapeSceneNode
      expect(bubble.bbox.x).toBe(100 + COMMENT_BUBBLE_OFFSET_PX)
      expect(bubble.bbox.y).toBe(100 + COMMENT_BUBBLE_OFFSET_PX)
    })

    it('honours caller-supplied obstacles, for a comment laid out apart from its canvas', () => {
      const alone = {
        nodes: [],
        edges: [],
        'x-whiteboard': { comments: [{ id: 'c1', x: 100, y: 100, text: 'x' }] },
      } satisfies SpatialCanvas
      const withoutObstacle = bubbleOf(
        layoutSpatialCanvas(alone, baseOptions()).nodes,
        'c1',
      ) as ShapeSceneNode
      const withObstacle = bubbleOf(
        layoutSpatialCanvas(
          alone,
          baseOptions({ commentObstacles: [{ x: 110, y: 110, w: 300, h: 300 }] }),
        ).nodes,
        'c1',
      ) as ShapeSceneNode
      expect(withoutObstacle.bbox.y).toBe(100 + COMMENT_BUBBLE_OFFSET_PX)
      expect(withObstacle.bbox.y + withObstacle.bbox.h).toBe(100 - COMMENT_BUBBLE_OFFSET_PX)
    })
  })
})

describe('a passage of a node’s text (the text arm naming a node)', () => {
  const NOTE: SpatialNode = {
    id: 'n1',
    type: 'text',
    x: 0,
    y: 0,
    width: 400,
    height: 100,
    text: 'ship the plan by friday',
  }
  const passage = (exact: string, status: CommentThread['status'] = 'open'): CommentThread => ({
    id: 't1',
    anchor: { kind: 'text', nodeId: 'n1', quote: { exact }, start: 0, end: 1 },
    status,
    messages: [{ id: 'm1', body: 'about it' }],
  })
  const highlightsOf = (nodes: readonly SceneNode[]) =>
    shapesOf(nodes).filter((shape) => shape.id?.startsWith('t1/passage-'))

  it('highlights exactly the quoted words, measured with the run’s own font, behind the run', () => {
    const scene = layoutSpatialCanvas(
      { nodes: [NOTE], edges: [] },
      baseOptions({ threads: [passage('plan')] }),
    )
    const run = runsOf(scene.nodes).find((r) => r.text.includes('plan'))
    expect(run).toBeDefined()
    const size = run?.appearance?.fontSize as number
    const [box] = highlightsOf(scene.nodes)
    expect(box).toBeDefined()
    // The fake measurer: 0.6em per character. "ship the " is nine.
    expect(box?.bbox).toEqual({
      x: (run?.bbox.x as number) + 9 * 0.6 * size,
      y: run?.bbox.y,
      w: 4 * 0.6 * size,
      h: run?.bbox.h,
    })
    expect(box?.commentChrome).toBe(true)
    expect(box?.appearance).toEqual({ fill: '#d97706', fillOpacity: 0.22 })
    // Painted before the run, so the words stay on top.
    const order = scene.nodes.indexOf(box as (typeof scene.nodes)[number])
    const runIndex = scene.nodes.findIndex(
      (n) =>
        (n.kind === 'paragraph' || n.kind === 'heading') && n.runs.includes(run as TextRunNode),
    )
    expect(order).toBeLessThan(runIndex)
  })

  it('follows a passage across a wrap with one box per line', () => {
    // Narrow enough that "plan by" breaks: the second box starts at its line's start.
    const scene = layoutSpatialCanvas(
      { nodes: [{ ...NOTE, width: 110 }], edges: [] },
      baseOptions({ threads: [passage('plan by friday')] }),
    )
    const boxes = highlightsOf(scene.nodes)
    expect(boxes.length).toBeGreaterThan(1)
    const ys = new Set(boxes.map((b) => b.bbox.y))
    expect(ys.size).toBe(boxes.length)
  })

  it('draws nothing for a quote the rendered text does not hold, or a resolved passage by default', () => {
    const gone = layoutSpatialCanvas(
      { nodes: [NOTE], edges: [] },
      baseOptions({ threads: [passage('monday')] }),
    )
    expect(highlightsOf(gone.nodes)).toEqual([])
    const resolved = layoutSpatialCanvas(
      { nodes: [NOTE], edges: [] },
      baseOptions({ threads: [passage('plan', 'resolved')] }),
    )
    expect(highlightsOf(resolved.nodes)).toEqual([])
    const shown = layoutSpatialCanvas(
      { nodes: [NOTE], edges: [] },
      baseOptions({ threads: [passage('plan', 'resolved')], showResolved: true }),
    )
    expect(highlightsOf(shown.nodes)).toHaveLength(1)
  })
})

describe('node sets and regions (the spatial arm with nodeIds or a rect)', () => {
  const A = { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' } as const
  const B = { id: 'b', type: 'text', x: 300, y: 200, width: 100, height: 50, text: 'b' } as const
  const setThread = (status: 'open' | 'resolved' = 'open'): CommentThread => ({
    id: 'set',
    anchor: { kind: 'spatial', nodeIds: ['a', 'b'], x: 0, y: 0, width: 10, height: 10 },
    status,
    messages: [{ id: 'm', body: 'these two' }],
  })
  const outlineOf = (nodes: readonly SceneNode[]) =>
    shapesOf(nodes).find((shape) => shape.id === 'set/region')

  it('outlines the box the live nodes occupy and stands the pin at its top-right corner', () => {
    const thread = setThread()
    // The flat projection carries a STALE corner (the nodes have moved
    // since it was taken); the pin follows the live box, not the memory.
    const scene = layoutSpatialCanvas(
      {
        nodes: [A, B],
        edges: [],
        'x-whiteboard': { comments: [{ id: 'set', x: 5, y: 5, text: 'these two' }] },
      },
      baseOptions({ threads: [thread] }),
    )
    expect(outlineOf(scene.nodes)?.bbox).toEqual({ x: 0, y: 0, w: 400, h: 250 })
    expect(outlineOf(scene.nodes)?.appearance).toEqual({
      fill: 'none',
      stroke: '#d97706',
      strokeWidth: 1.5,
      strokeDasharray: '6 4',
    })
    expect(outlineOf(scene.nodes)?.commentChrome).toBe(true)
    const pin = shapesOf(scene.nodes).find((shape) => shape.id === 'set/pin')
    expect(pin?.bbox).toMatchObject({
      x: 400 - COMMENT_PIN_SIZE_PX / 2,
      y: -COMMENT_PIN_SIZE_PX / 2,
    })
    // The outline paints under the pin.
    const ids = scene.nodes.map((n) => (n.kind === 'shape' ? n.id : undefined))
    expect(ids.indexOf('set/region')).toBeLessThan(ids.indexOf('set/pin'))
  })

  it('falls back to the stored rect once every node is gone, and hides a resolved one unless asked', () => {
    const orphan = layoutSpatialCanvas(
      { nodes: [], edges: [] },
      baseOptions({ threads: [setThread()] }),
    )
    expect(outlineOf(orphan.nodes)?.bbox).toEqual({ x: 0, y: 0, w: 10, h: 10 })
    const resolved = layoutSpatialCanvas(
      { nodes: [A, B], edges: [] },
      baseOptions({ threads: [setThread('resolved')] }),
    )
    expect(outlineOf(resolved.nodes)).toBeUndefined()
    const shown = layoutSpatialCanvas(
      { nodes: [A, B], edges: [] },
      baseOptions({ threads: [setThread('resolved')], showResolved: true }),
    )
    expect(outlineOf(shown.nodes)?.appearance).toMatchObject({ strokeOpacity: 0.45 })
  })

  it('draws no outline for a point, node or edge anchor', () => {
    const scene = layoutSpatialCanvas(
      { nodes: [A], edges: [] },
      baseOptions({
        threads: [
          {
            id: 'p',
            anchor: { kind: 'spatial', nodeId: 'a', x: 0, y: 0 },
            status: 'open',
            messages: [{ id: 'm', body: 'x' }],
          },
        ],
      }),
    )
    expect(shapesOf(scene.nodes).some((shape) => shape.id?.endsWith('/region'))).toBe(false)
  })
})

/**
 * How much is in a conversation, on the PIN.
 *
 * Every other surface that lists or marks one says this — the rail's row,
 * the markdown gutter, the preview marker — and the canvas was the last one
 * that did not, so a reader crossing between them met the same conversation
 * described two ways. It comes from `threads`, which the layout already
 * takes for regions and passage highlights; the flat `comments` projection
 * carries one text and cannot know.
 *
 * Composed into the SCENE rather than drawn by a host, so the widget, the
 * export and `wb_scene_render` get it for the same reason they get the pin.
 */
function pinCountRun(nodes: readonly SceneNode[], commentId: string): TextRunNode | undefined {
  const pin = pinOf(nodes, commentId)
  if (pin === undefined) return undefined
  // Found by sitting ON the pin rather than by an id: `TextRunNode` carries
  // none, and "is on the pin" is the claim in any case.
  return runsOf(nodes).find(
    (run) =>
      /^\d+$/.test(run.text) &&
      run.bbox.x >= pin.bbox.x &&
      run.bbox.x + run.bbox.w <= pin.bbox.x + pin.bbox.w &&
      run.bbox.y >= pin.bbox.y &&
      run.bbox.y + run.bbox.h <= pin.bbox.y + pin.bbox.h,
  )
}

function pinCountOf(nodes: readonly SceneNode[], commentId: string): string | undefined {
  return pinCountRun(nodes, commentId)?.text
}

function threadOf(id: string, messages: number, status: 'open' | 'resolved' = 'open') {
  return {
    id,
    anchor: { kind: 'spatial', x: 40, y: 40 } as const,
    status,
    messages: Array.from({ length: messages }, (_, i) => ({ id: `${id}-m${i}`, body: `m${i}` })),
  } satisfies CommentThread
}

describe('the count a pin carries', () => {
  it('draws how many messages the conversation holds, once there is more than one', () => {
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 40, y: 40, text: 'is that right?' }]),
      baseOptions({ threads: [threadOf('c1', 3)] }),
    )
    expect(pinCountOf(scene.nodes, 'c1')).toBe('3')
  })

  it('draws none for a lone remark, where a digit beside prose is noise', () => {
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 40, y: 40, text: 'is that right?' }]),
      baseOptions({ threads: [threadOf('c1', 1)] }),
    )
    expect(pinCountOf(scene.nodes, 'c1')).toBeUndefined()
    expect(pinOf(scene.nodes, 'c1')).toBeDefined()
  })

  it('draws none for a comment no thread was handed for, rather than inventing one', () => {
    // The flat projection carries one text and no conversation. A host that
    // passes no `threads` — an old export, a caller that has not wired them
    // — gets the pin it always got.
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 40, y: 40, text: 'is that right?' }]),
      baseOptions(),
    )
    expect(pinCountOf(scene.nodes, 'c1')).toBeUndefined()
    expect(pinOf(scene.nodes, 'c1')).toBeDefined()
  })

  it('sits on the pin, not beside it', () => {
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 40, y: 40, text: 'is that right?' }]),
      baseOptions({ threads: [threadOf('c1', 12)] }),
    )
    // Two digits is the widest a count gets before it stops fitting, so it
    // is the case that decides the font size. `pinCountRun` only matches a
    // run wholly inside the pin's box, so finding one IS the claim: a
    // number that drifts off reads as a stray glyph on the canvas.
    expect(pinCountOf(scene.nodes, 'c1')).toBe('12')
  })

  it('is muted with its pin once the conversation is resolved', () => {
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 40, y: 40, text: 'settled', resolved: true }]),
      baseOptions({ threads: [threadOf('c1', 4, 'resolved')], showResolved: true }),
    )
    // Assigned from the theme's resolved overlay, never an opacity literal
    // here — the same rule the pin under it follows.
    expect(pinCountRun(scene.nodes, 'c1')?.appearance?.fillOpacity).toBe(0.45)
  })
})

/**
 * A comment's body IS markdown, and the bubble draws it through the one
 * producer every other surface uses (`layoutCommentBody`).
 *
 * Pinned at the bubble rather than only on the producer because the drift
 * this closes ran the other way: the web app's card and rail printed the
 * same string raw while the bubble had always parsed it, so `# Heading`
 * was a heading on the canvas and a literal hash in the rail. A test on
 * the producer alone would stay green over a bubble that grew its own
 * path back.
 *
 * The HEADING is what makes it discriminating: the node and document
 * markdown themes agree on body size and differ at h1 (24 vs 30), so a
 * paragraph would pass under either.
 */
it('draws a comment body as markdown at the bubble metrics, through the shared producer', () => {
  const scene = layoutSpatialCanvas(
    canvasWith([{ id: 'c1', x: 400, y: 40, text: '# Heading' }]),
    // codec's real parser, not the fixture's paragraph-wrapping stub: the
    // claim is about what markdown MEANS here.
    baseOptions({ parseBody: parseMarkdownBody }),
  )
  const heading = scene.nodes.find((node) => node.kind === 'heading')
  expect(heading).toBeDefined()
  const run = (heading as { runs?: readonly TextRunNode[] }).runs?.[0]
  expect(run?.text).toBe('Heading')
  expect(run?.appearance?.fontSize).toBe(MARKDOWN_THEME_NODE.headingFontSizePx[1])
})

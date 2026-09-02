// The comment annotation layer's rendering (ADR-0024 decision 4): pins and
// bubbles composed into the SVG scene AFTER nodes and edges, so they paint
// above content on every surface — widget, viewer, export — with no per-
// surface wiring. Placement floats near the anchor; nothing here is stored.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import type { ResolvedEdgeNode, SceneNode, ShapeSceneNode, TextRunNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
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

// Comment text lays out through the mdast pipeline, so its runs sit inside
// paragraph/heading BLOCK nodes rather than at the top level.
function runsOf(nodes: readonly SceneNode[]): TextRunNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'textRun') return [node]
    if (node.kind === 'paragraph' || node.kind === 'heading') return [...node.runs]
    return []
  })
}

describe('comment layer', () => {
  it('draws a pin centered on the anchor and a bubble holding the text, after all content', () => {
    const scene = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 400, y: 60, text: 'move this left' }]),
      baseOptions(),
    )

    const shapes = shapesOf(scene.nodes)
    const pin = shapes.find((shape) => shape.bbox.w === COMMENT_PIN_SIZE_PX)
    expect(pin).toBeDefined()
    expect(pin?.bbox.x).toBe(400 - COMMENT_PIN_SIZE_PX / 2)
    expect(pin?.bbox.y).toBe(60 - COMMENT_PIN_SIZE_PX / 2)
    // A circle: the rect chrome with radius = half its side.
    expect(pin?.radius).toBe(COMMENT_PIN_SIZE_PX / 2)
    expect(pin?.appearance).toEqual({ fill: '#d97706' })

    const bubble = shapes.find((shape) => shape.appearance?.fill === '#fef3c7')
    expect(bubble).toBeDefined()
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
    const shapes = shapesOf(scene.nodes)
    const pin = shapes.find((shape) => shape.bbox.w === COMMENT_PIN_SIZE_PX)
    const bubble = shapes.find((shape) => shape.appearance?.fill === '#fef3c7')
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
    const followedPin = shapesOf(followed.nodes).find(
      (shape) => shape.bbox.w === COMMENT_PIN_SIZE_PX,
    )
    // Pinned to the node's top-right corner, not the stored anchor.
    expect(followedPin?.bbox.x).toBe(200 - COMMENT_PIN_SIZE_PX / 2)
    expect(followedPin?.bbox.y).toBe(0 - COMMENT_PIN_SIZE_PX / 2)

    const dangling = layoutSpatialCanvas(
      canvasWith([{ id: 'c1', x: 50, y: 70, text: 'about a deleted node', targetNodeId: 'gone' }]),
      baseOptions(),
    )
    const danglingPin = shapesOf(dangling.nodes).find(
      (shape) => shape.bbox.w === COMMENT_PIN_SIZE_PX,
    )
    expect(danglingPin?.bbox.x).toBe(50 - COMMENT_PIN_SIZE_PX / 2)
    expect(danglingPin?.bbox.y).toBe(70 - COMMENT_PIN_SIZE_PX / 2)
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
    const pin = shapesOf(scene.nodes).find((shape) => shape.bbox.w === COMMENT_PIN_SIZE_PX)
    expect(pin).toBeDefined()
    expect(pin?.appearance).toBeUndefined()
    expect(runsOf(scene.nodes).map((run) => run.text)).toContain('still drawn')
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
})

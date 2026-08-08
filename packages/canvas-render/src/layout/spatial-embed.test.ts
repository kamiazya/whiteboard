// Inline file-node embeds: the referenced canvas renders as a scaled
// miniature inside the node's content area, gated by the caller's
// expansion policy, with the depth cap and path-local cycle handling this
// package's embed contract already promises.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import type { EmbedResolvedNode, ShapeSceneNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

function baseOptions(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: () => ({ type: 'root', children: [] }),
    appearance: APPEARANCE,
    ...over,
  }
}

const fileNode = (over?: Partial<Extract<SpatialNode, { type: 'file' }>>) =>
  ({
    id: 'f1',
    type: 'file',
    x: 100,
    y: 100,
    width: 220,
    height: 180,
    file: 'child',
    ...over,
  }) satisfies SpatialNode

const childCanvas: SpatialCanvas = {
  nodes: [{ id: 'c1', type: 'text', x: 0, y: 0, width: 400, height: 200, text: '' }],
  edges: [],
}

function embedOf(scene: { nodes: readonly { kind: string }[] }): EmbedResolvedNode | undefined {
  return scene.nodes.find((n): n is EmbedResolvedNode => n.kind === 'embedResolved')
}

describe('file-node inline embeds', () => {
  it('expands a resolved reference into a scaled miniature inside the content area', () => {
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveFileCanvas: (file) => (file === 'child' ? childCanvas : undefined),
        expandFileNode: () => true,
      }),
    )
    const embed = embedOf(scene)
    expect(embed).toBeDefined()
    expect(embed?.canvasId).toBe('child')

    // The child's 400x200 shape fits the node's inner area scaled down —
    // every embedded coordinate stays inside the node box.
    const childShape = embed?.children.find((n): n is ShapeSceneNode => n.kind === 'shape')
    expect(childShape).toBeDefined()
    const box = childShape as ShapeSceneNode
    expect(box.bbox.w).toBeLessThan(400)
    expect(box.bbox.x).toBeGreaterThanOrEqual(100)
    expect(box.bbox.x + box.bbox.w).toBeLessThanOrEqual(320)
    expect(box.bbox.y + box.bbox.h).toBeLessThanOrEqual(280)

    // The reference label sits OUTSIDE, above the frame (container
    // convention), leaving the whole padded box to the miniature.
    const label = scene.nodes.find(
      (n): n is import('../scene-graph.js').TextRunNode => n.kind === 'textRun',
    )
    expect(label !== undefined && label.bbox.y + label.bbox.h <= 100).toBe(true)
  })

  it('never upscales a small child (fit caps at 1)', () => {
    const tiny: SpatialCanvas = {
      nodes: [{ id: 'c1', type: 'text', x: 0, y: 0, width: 40, height: 20, text: '' }],
      edges: [],
    }
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({ resolveFileCanvas: () => tiny, expandFileNode: () => true }),
    )
    const shape = embedOf(scene)?.children.find((n): n is ShapeSceneNode => n.kind === 'shape')
    expect(shape?.bbox.w).toBe(40)
  })

  it('keeps the card without a resolver, without expansion, or on an unresolvable reference', () => {
    const noResolver = layoutSpatialCanvas({ nodes: [fileNode()], edges: [] }, baseOptions())
    expect(embedOf(noResolver)).toBeUndefined()

    const collapsed = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({ resolveFileCanvas: () => childCanvas, expandFileNode: () => false }),
    )
    expect(embedOf(collapsed)).toBeUndefined()

    const unresolvable = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({ resolveFileCanvas: () => undefined, expandFileNode: () => true }),
    )
    expect(embedOf(unresolvable)).toBeUndefined()
  })

  it('degrades a cycle on the current path to the card instead of recursing forever', () => {
    const a: SpatialCanvas = { nodes: [fileNode({ id: 'fa', file: 'b' })], edges: [] }
    const b: SpatialCanvas = { nodes: [fileNode({ id: 'fb', file: 'a' })], edges: [] }
    const scene = layoutSpatialCanvas(
      a,
      baseOptions({
        resolveFileCanvas: (file) => (file === 'a' ? a : file === 'b' ? b : undefined),
        expandFileNode: () => true,
      }),
    )
    // Path-local means the REFERENCE chain: the root canvas itself was not
    // reached via a reference, so a → b → a renders one more level before
    // the 'b' reference inside that inner 'a' hits the path and degrades
    // to the card. The point pinned here is boundedness, not zero nesting.
    const outer = embedOf(scene)
    expect(outer?.canvasId).toBe('b')
    const inner = outer?.children.find((n): n is EmbedResolvedNode => n.kind === 'embedResolved')
    expect(inner?.canvasId).toBe('a')
    const third = inner?.children.find((n) => n.kind === 'embedResolved')
    expect(third).toBeUndefined()
  })

  it('caps recursion depth at 3', () => {
    const canvases: Record<string, SpatialCanvas> = {}
    for (let i = 0; i < 6; i += 1) {
      canvases[`c${i}`] = { nodes: [fileNode({ id: `f${i}`, file: `c${i + 1}` })], edges: [] }
    }
    canvases.c6 = { nodes: [], edges: [] }
    const scene = layoutSpatialCanvas(
      canvases.c0 as SpatialCanvas,
      baseOptions({ resolveFileCanvas: (file) => canvases[file], expandFileNode: () => true }),
    )
    let depth = 0
    let current = embedOf(scene)
    while (current !== undefined) {
      depth += 1
      current = current.children.find((n): n is EmbedResolvedNode => n.kind === 'embedResolved')
    }
    expect(depth).toBe(3)
  })
})

describe('file-node images', () => {
  it('renders a resolved image full-bleed in the padded box with the accessible name', () => {
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveFileImage: (file) =>
          file === 'child' ? { href: 'data:image/png;base64,AAA', alt: 'A chart' } : undefined,
      }),
    )
    const image = scene.nodes.find((n) => n.kind === 'image')
    if (image === undefined || image.kind !== 'image') throw new Error('image expected')
    expect(image.href).toBe('data:image/png;base64,AAA')
    expect(image.alt).toBe('A chart')
    // Padded box of the 220x180 node at (100,100).
    expect(image.bbox.x).toBeGreaterThan(100)
    expect(image.bbox.w).toBeLessThan(220)
    // No label run overlaps the picture.
    expect(scene.nodes.some((n) => n.kind === 'textRun')).toBe(false)
  })

  it('image resolution wins over the canvas-embed seam and failures keep the card', () => {
    const both = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveFileImage: () => ({ href: 'data:image/png;base64,AAA' }),
        resolveFileCanvas: () => childCanvas,
        expandFileNode: () => true,
      }),
    )
    expect(both.nodes.some((n) => n.kind === 'image')).toBe(true)
    expect(both.nodes.some((n) => n.kind === 'embedResolved')).toBe(false)

    const throwing = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveFileImage: () => {
          throw new Error('boom')
        },
      }),
    )
    expect(throwing.nodes.some((n) => n.kind === 'image')).toBe(false)
    // The card label still renders.
    expect(throwing.nodes.some((n) => n.kind === 'textRun')).toBe(true)
  })
})

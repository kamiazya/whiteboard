// Inline file-node embeds: the referenced canvas renders as a scaled
// miniature inside the node's content area, gated by the caller's
// expansion policy, with the depth cap and path-local cycle handling this
// package's embed contract already promises.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type {
  EmbedResolvedNode,
  HeadingBlockNode,
  ParagraphBlockNode,
  ShapeSceneNode,
} from '../scene-graph.js'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import {
  type FacetCardData,
  layoutSpatialCanvas,
  type SpatialLayoutOptions,
} from './spatial-canvas.js'

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
        resolveReference: (ref) => (ref === 'child' ? { canvas: childCanvas } : undefined),
        expandFileNode: () => true,
      }),
    )
    const embed = embedOf(scene)
    expect(embed).toBeDefined()
    expect(embed?.documentId).toBe('child')

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
      baseOptions({ resolveReference: () => ({ canvas: tiny }), expandFileNode: () => true }),
    )
    const shape = embedOf(scene)?.children.find((n): n is ShapeSceneNode => n.kind === 'shape')
    expect(shape?.bbox.w).toBe(40)
  })

  it('keeps the card without a resolver, without expansion, or on an unresolvable reference', () => {
    const noResolver = layoutSpatialCanvas({ nodes: [fileNode()], edges: [] }, baseOptions())
    expect(embedOf(noResolver)).toBeUndefined()

    const collapsed = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveReference: () => ({ canvas: childCanvas }),
        expandFileNode: () => false,
      }),
    )
    expect(embedOf(collapsed)).toBeUndefined()

    const unresolvable = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({ resolveReference: () => undefined, expandFileNode: () => true }),
    )
    expect(embedOf(unresolvable)).toBeUndefined()
  })

  it('a resolved canvas embed wins over a resolved facet card', () => {
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveReference: (ref) =>
          ref === 'child'
            ? {
                canvas: childCanvas,
                facets: { title: 'Card', rows: [{ label: 'type', value: 'note' }] },
              }
            : undefined,
        expandFileNode: () => true,
      }),
    )
    expect(embedOf(scene)).toBeDefined()
    expect(scene.nodes.some((n) => n.kind === 'heading')).toBe(false)
  })

  it("keeps a line-jump child's hop points inside the frame (jumps transform with the path)", () => {
    // Two crossing edges in a large child force a jump; laid out at native
    // size the hop sits at child coordinates far outside the parent frame,
    // so a scale/translate that misses `jumps` draws the arc outside it.
    const crossing: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: '' },
        { id: 'b', type: 'text', x: 400, y: 0, width: 100, height: 50, text: '' },
        { id: 'c', type: 'text', x: 200, y: -300, width: 100, height: 50, text: '' },
        { id: 'd', type: 'text', x: 200, y: 300, width: 100, height: 50, text: '' },
      ],
      edges: [
        { id: 'h', fromNode: 'a', toNode: 'b' },
        { id: 'v', fromNode: 'c', toNode: 'd' },
      ],
      'x-whiteboard': { edgeRouting: { style: 'orthogonal', lineJumps: 'arc' } },
    }
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({ resolveReference: () => ({ canvas: crossing }), expandFileNode: () => true }),
    )
    const edges = (embedOf(scene)?.children ?? []).filter(
      (n): n is import('../scene-graph.js').ResolvedEdgeNode => n.kind === 'edge',
    )
    const jumps = edges.flatMap((edge) => edge.jumps ?? [])
    expect(jumps.length).toBeGreaterThan(0)
    for (const jump of jumps) {
      expect(jump.x).toBeGreaterThanOrEqual(100)
      expect(jump.x).toBeLessThanOrEqual(320)
      expect(jump.y).toBeGreaterThanOrEqual(100)
      expect(jump.y).toBeLessThanOrEqual(280)
    }
  })

  it('degrades a cycle on the current path to the card instead of recursing forever', () => {
    const a: SpatialCanvas = { nodes: [fileNode({ id: 'fa', file: 'b' })], edges: [] }
    const b: SpatialCanvas = { nodes: [fileNode({ id: 'fb', file: 'a' })], edges: [] }
    const scene = layoutSpatialCanvas(
      a,
      baseOptions({
        resolveReference: (ref) =>
          ref === 'a' ? { canvas: a } : ref === 'b' ? { canvas: b } : undefined,
        expandFileNode: () => true,
      }),
    )
    // Path-local means the REFERENCE chain: the root canvas itself was not
    // reached via a reference, so a → b → a renders one more level before
    // the 'b' reference inside that inner 'a' hits the path and degrades
    // to the card. The point pinned here is boundedness, not zero nesting.
    const outer = embedOf(scene)
    expect(outer?.documentId).toBe('b')
    const inner = outer?.children.find((n): n is EmbedResolvedNode => n.kind === 'embedResolved')
    expect(inner?.documentId).toBe('a')
    const third = inner?.children.find((n) => n.kind === 'embedResolved')
    expect(third).toBeUndefined()
  })

  it('caps recursion depth at 3', () => {
    const documents: Record<string, SpatialCanvas> = {}
    for (let i = 0; i < 6; i += 1) {
      documents[`c${i}`] = { nodes: [fileNode({ id: `f${i}`, file: `c${i + 1}` })], edges: [] }
    }
    documents.c6 = { nodes: [], edges: [] }
    const scene = layoutSpatialCanvas(
      documents.c0 as SpatialCanvas,
      baseOptions({
        resolveReference: (ref) => {
          const canvas = documents[ref]
          return canvas === undefined ? undefined : { canvas }
        },
        expandFileNode: () => true,
      }),
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
        resolveReference: (ref) =>
          ref === 'child'
            ? { image: { href: 'data:image/png;base64,AAA', alt: 'A chart' } }
            : undefined,
      }),
    )
    const image = scene.nodes.find((n) => n.kind === 'image')
    if (image === undefined || image.kind !== 'image') throw new Error('image expected')
    expect(image.href).toBe('data:image/png;base64,AAA')
    expect(image.alt).toBe('A chart')
    // Padded box of the 220x180 node at (100,100).
    expect(image.bbox.x).toBeGreaterThan(100)
    expect(image.bbox.w).toBeLessThan(220)
    expect(image.bbox.y).toBeGreaterThan(100)
    expect(image.bbox.h).toBeLessThan(180)
    // No label run overlaps the picture.
    expect(scene.nodes.some((n) => n.kind === 'textRun')).toBe(false)
  })

  it('image resolution wins over the canvas-embed seam and failures keep the card', () => {
    const both = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveReference: () => ({
          image: { href: 'data:image/png;base64,AAA' },
          canvas: childCanvas,
        }),
        expandFileNode: () => true,
      }),
    )
    expect(both.nodes.some((n) => n.kind === 'image')).toBe(true)
    expect(both.nodes.some((n) => n.kind === 'embedResolved')).toBe(false)

    const throwing = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveReference: () => {
          throw new Error('boom')
        },
      }),
    )
    expect(throwing.nodes.some((n) => n.kind === 'image')).toBe(false)
    // The card label still renders.
    expect(throwing.nodes.some((n) => n.kind === 'textRun')).toBe(true)
  })

  it('image resolution wins over a resolved facet card', () => {
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveReference: () => ({
          image: { href: 'data:image/png;base64,AAA' },
          facets: { title: 'Card', rows: [{ label: 'type', value: 'note' }] },
        }),
      }),
    )
    expect(scene.nodes.some((n) => n.kind === 'image')).toBe(true)
    expect(scene.nodes.some((n) => n.kind === 'heading')).toBe(false)
  })
})

describe('file-node facet cards', () => {
  const card: FacetCardData = {
    title: 'Ship it',
    rows: [
      { label: 'type', value: 'issue' },
      { label: 'tags', value: 'a, b' },
    ],
  }

  it("renders the card's title and rows, replacing the plain label", () => {
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({ resolveReference: (ref) => (ref === 'child' ? { facets: card } : undefined) }),
    )
    const heading = scene.nodes.find((n): n is HeadingBlockNode => n.kind === 'heading')
    expect(heading?.runs.map((run) => run.text).join('')).toBe('Ship it')

    const paragraphs = scene.nodes.filter((n): n is ParagraphBlockNode => n.kind === 'paragraph')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]?.runs.map((run) => run.text).join('')).toBe('type: issue')
    expect(paragraphs[1]?.runs.map((run) => run.text).join('')).toBe('tags: a, b')

    // The raw file label is a plain top-level textRun — the card replaces it.
    expect(scene.nodes.some((n) => n.kind === 'textRun')).toBe(false)

    // Card content is drawn strictly inside the node's own padded box.
    for (const entry of [heading, ...paragraphs]) {
      expect(entry).toBeDefined()
      expect(entry!.bbox.x).toBeGreaterThanOrEqual(100)
      expect(entry!.bbox.y).toBeGreaterThanOrEqual(100)
      expect(entry!.bbox.x + entry!.bbox.w).toBeLessThanOrEqual(320)
      expect(entry!.bbox.y + entry!.bbox.h).toBeLessThanOrEqual(280)
    }
  })

  it('wins over the plain label when both resolvers resolve', () => {
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveReference: () => ({ label: 'A human title', facets: card }),
      }),
    )
    expect(scene.nodes.some((n) => n.kind === 'textRun')).toBe(false)
    expect(scene.nodes.some((n) => n.kind === 'heading')).toBe(true)
  })

  it('degrades to the plain chrome+label rendering when there is no usable card data', () => {
    const canvas: SpatialCanvas = { nodes: [fileNode()], edges: [] }
    const baseline = layoutSpatialCanvas(canvas, baseOptions())
    const baselineSvg = renderSceneToSvg(baseline)

    const noResolverScene = layoutSpatialCanvas(canvas, baseOptions())
    expect(noResolverScene).toEqual(baseline)
    expect(renderSceneToSvg(noResolverScene)).toBe(baselineSvg)

    const resolvers: Array<() => { facets?: FacetCardData } | undefined> = [
      () => undefined,
      () => {
        throw new Error('boom')
      },
      () => ({ facets: { rows: [] } }),
      () => ({ facets: { title: '   ', rows: [{ label: '', value: '' }] } }),
    ]
    for (const resolveReference of resolvers) {
      const scene = layoutSpatialCanvas(canvas, baseOptions({ resolveReference }))
      expect(scene).toEqual(baseline)
      expect(renderSceneToSvg(scene)).toBe(baselineSvg)
    }
  })

  it('truncates content that overflows the node box at whole-block granularity', () => {
    const shortNode = fileNode({ height: 100 })
    const manyRows: FacetCardData = {
      title: 'Overflowing',
      rows: Array.from({ length: 40 }, (_, i) => ({ label: `k${i}`, value: `v${i}` })),
    }
    const scene = layoutSpatialCanvas(
      { nodes: [shortNode], edges: [] },
      baseOptions({ resolveReference: () => ({ facets: manyRows }) }),
    )
    const blocks = scene.nodes.filter((n) => n.kind === 'heading' || n.kind === 'paragraph')
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.length).toBeLessThan(41)
    for (const block of blocks) {
      expect(block.bbox.y + block.bbox.h).toBeLessThanOrEqual(shortNode.y + shortNode.height - 8)
    }
  })

  it('keeps the chrome-only rendering for a degenerate (zero-size) node rather than throwing', () => {
    const zeroNode = fileNode({ width: 0, height: 0 })
    expect(() =>
      layoutSpatialCanvas(
        { nodes: [zeroNode], edges: [] },
        baseOptions({ resolveReference: () => ({ facets: card }) }),
      ),
    ).not.toThrow()
    const scene = layoutSpatialCanvas(
      { nodes: [zeroNode], edges: [] },
      baseOptions({ resolveReference: () => ({ facets: card }) }),
    )
    expect(scene.nodes.some((n) => n.kind === 'heading' || n.kind === 'paragraph')).toBe(false)
  })

  it('renders byte-identical SVG for the same canvas laid out twice (determinism)', () => {
    const canvas: SpatialCanvas = { nodes: [fileNode()], edges: [] }
    const options = baseOptions({ resolveReference: () => ({ facets: card }) })
    const svgA = renderSceneToSvg(layoutSpatialCanvas(canvas, options))
    const svgB = renderSceneToSvg(layoutSpatialCanvas(canvas, options))
    expect(svgA).toBe(svgB)
  })

  it('emits the card within its own node slot, in document order ahead of a later node', () => {
    const textNode: SpatialNode = {
      id: 't1',
      type: 'text',
      x: 400,
      y: 100,
      width: 100,
      height: 100,
      text: '',
    }
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode(), textNode], edges: [] },
      baseOptions({ resolveReference: () => ({ facets: card }) }),
    )
    const headingIndex = scene.nodes.findIndex((n) => n.kind === 'heading')
    const textChromeIndex = scene.nodes.findIndex(
      (n) => n.kind === 'shape' && n.bbox.x === 400 && n.bbox.y === 100,
    )
    expect(headingIndex).toBeGreaterThanOrEqual(0)
    expect(textChromeIndex).toBeGreaterThan(headingIndex)
  })
})

describe('shape facets inside an embedded canvas', () => {
  const shapedChild: SpatialCanvas = {
    nodes: [
      {
        id: 'c1',
        type: 'text',
        x: 0,
        y: 0,
        width: 400,
        height: 200,
        text: '',
        'x-whiteboard': { facets: { 'visual.shape/v0': { kind: 'hexagon' } } },
      },
    ],
    edges: [],
  }

  it("a child node's visual.shape facet draws its silhouette, same as at the root", () => {
    const scene = layoutSpatialCanvas(
      { nodes: [fileNode()], edges: [] },
      baseOptions({
        resolveReference: () => ({ canvas: shapedChild }),
        expandFileNode: () => true,
      }),
    )
    const childShape = embedOf(scene)?.children.find((n): n is ShapeSceneNode => n.kind === 'shape')
    expect(childShape?.shape).toBe('hexagon')
  })

  it("a child node NEVER inherits a same-id ROOT node's shape", () => {
    // The root canvas carries a shaped node whose id collides with the
    // plain child node — resolution keyed off the root map would leak the
    // root's silhouette into the embedded document.
    const root: SpatialCanvas = {
      nodes: [
        fileNode(),
        {
          id: 'c1',
          type: 'text',
          x: 500,
          y: 100,
          width: 100,
          height: 100,
          text: '',
          'x-whiteboard': { facets: { 'visual.shape/v0': { kind: 'diamond' } } },
        },
      ],
      edges: [],
    }
    const scene = layoutSpatialCanvas(
      root,
      baseOptions({
        resolveReference: () => ({ canvas: childCanvas }),
        expandFileNode: (n) => n.type === 'file',
      }),
    )
    const childShape = embedOf(scene)?.children.find((n): n is ShapeSceneNode => n.kind === 'shape')
    expect(childShape).toBeDefined()
    expect(childShape?.shape).toBeUndefined()
  })
})

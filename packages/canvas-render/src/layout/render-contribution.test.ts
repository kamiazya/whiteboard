// A plugin's rendering contribution is ONE object, and the renderer holds no
// facet key of its own.
//
// Three options had accumulated one per increment — `shapes`, `shapeFacets`,
// `decorations` — and the reader and text placement would have made five. None
// had a caller outside this package, so collapsing them costs nothing and the
// two remaining hard-coded reads stop being special.
//
// The namespace still comes from the CONTRIBUTION, never from a payload: a
// reader answers a bare kind and this package composes the id, so a document
// cannot name another plugin's geometry however it is written.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { SceneNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import {
  layoutSpatialCanvas,
  type RenderContribution,
  type SpatialLayoutOptions,
} from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({ fill: '#336699' }),
}

function baseOptions(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: () => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'body' }] }],
    }),
    appearance: APPEARANCE,
    ...over,
  }
}

const TRIANGLE = {
  outline: (box: { x: number; y: number; w: number; h: number }) =>
    ({
      kind: 'polygon',
      points: [
        { x: box.x, y: box.y + box.h },
        { x: box.x + box.w, y: box.y + box.h },
        { x: box.x + box.w, y: box.y },
      ],
    }) as const,
}

const readFacet =
  (key: string) =>
  (node: SpatialNode): string | undefined => {
    const stored = node['x-whiteboard']?.facets?.[key]
    if (stored === null || typeof stored !== 'object') return undefined
    const kind = (stored as { readonly kind?: unknown }).kind
    return typeof kind === 'string' && kind !== '' ? kind : undefined
  }

const DEMO: RenderContribution = {
  namespace: 'demo',
  // BARE names — the namespace above composes them.
  shapes: { triangle: TRIANGLE },
  readShape: readFacet('demo.shape/v0'),
  readTextPlacement: (node) => (node.id === 'topper' ? 'start' : undefined),
}

const canvasOf = (id: string, facets?: Record<string, unknown>): SpatialCanvas => ({
  nodes: [
    {
      id,
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      text: id,
      ...(facets === undefined ? {} : { 'x-whiteboard': { facets } }),
    },
  ],
  edges: [],
})

const shapeOf = (nodes: readonly SceneNode[]) =>
  nodes.find((n): n is Extract<SceneNode, { kind: 'shape' }> => n.kind === 'shape')

describe('a render contribution', () => {
  it('supplies its own facet reader, and the namespace composes the id', () => {
    const scene = layoutSpatialCanvas(
      canvasOf('n1', { 'demo.shape/v0': { kind: 'triangle' } }),
      baseOptions({ renderContributions: [DEMO] }),
    )
    expect(shapeOf(scene.nodes)?.shape).toBe('demo.triangle')
  })

  it('cannot name another contribution’s geometry from a payload', () => {
    // The reader answers a bare kind and `demo` composes it, so this asks for
    // `demo.visual.diamond` — which answers to nothing.
    const scene = layoutSpatialCanvas(
      canvasOf('n1', { 'demo.shape/v0': { kind: 'visual.diamond' } }),
      baseOptions({ renderContributions: [DEMO] }),
    )
    expect(shapeOf(scene.nodes)?.shape).toBe('demo.visual.diamond')
  })

  it('supplies text placement, which had no contribution point at all', () => {
    const centred = layoutSpatialCanvas(
      canvasOf('n1'),
      baseOptions({ renderContributions: [{ ...DEMO, readTextPlacement: () => 'center' }] }),
    )
    const topped = layoutSpatialCanvas(
      canvasOf('topper'),
      baseOptions({ renderContributions: [DEMO] }),
    )

    const yOf = (nodes: readonly SceneNode[]) =>
      nodes.find((n) => n.kind !== 'shape' && 'bbox' in n)?.bbox.y
    // A plain rect tops its content by default, so asking to centre must move
    // it down and asking for top must not.
    expect(yOf(centred.nodes)).toBeGreaterThan(yOf(topped.nodes) ?? 0)
  })

  it('still ships visual’s shapes, badge and placement with nothing wired', () => {
    const scene = layoutSpatialCanvas(
      canvasOf('n1', {
        'visual.shape/v0': { kind: 'diamond' },
        'visual.symbol/v0': { kind: 'emoji', char: '⭐' },
      }),
      baseOptions(),
    )
    expect(shapeOf(scene.nodes)?.shape).toBe('visual.diamond')
    expect(scene.nodes.map((n) => n.kind)).toContain('glyph')
  })

  it('composes several contributions rather than letting one win', () => {
    const scene = layoutSpatialCanvas(
      canvasOf('n1', {
        'demo.shape/v0': { kind: 'triangle' },
        'visual.symbol/v0': { kind: 'emoji', char: '⭐' },
      }),
      baseOptions({ renderContributions: [VISUAL_FOR_TEST, DEMO] }),
    )
    // demo's silhouette AND visual's badge, from two contributions at once.
    expect(shapeOf(scene.nodes)?.shape).toBe('demo.triangle')
    expect(scene.nodes.map((n) => n.kind)).toContain('glyph')
  })
})

// Imported late so the "nothing wired" case above reads as the default rather
// than as this constant.
import { visualRenderContribution as VISUAL_FOR_TEST } from '@kamiazya/whiteboard-plugin-visual/render'

// A shape is a NAMED geometry, and the name carries its owner. Before this,
// `canvas-render` held the five silhouettes `visual` happens to ship as a
// closed union, so no plugin could add one — and two plugins wanting a shape
// each called `diamond` had nowhere to put the second.
//
// The name is composed, never stored: the facet key `demo.shape/v0` supplies
// the namespace and the payload supplies the bare kind. A plugin therefore
// cannot reach another plugin's geometry by writing its id into a payload,
// because the payload never holds a namespace.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { SceneNode } from '../scene-graph.js'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const APPEARANCE = { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) }

function baseOptions(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    // A real block, because the content-box case needs runs to place.
    parseBody: () => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'ab' }] }],
    }),
    appearance: APPEARANCE,
    ...over,
  }
}

/** A right triangle — deliberately nothing `visual` ships, so a pass cannot
 *  come from a built-in of the same name. */
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
  contentBox: (box: { x: number; y: number; w: number; h: number }) => ({
    x: box.x + box.w / 2,
    y: box.y + box.h / 2,
    w: box.w / 2,
    h: box.h / 2,
  }),
}

function canvasWith(facetKey: string, kind: string): SpatialCanvas {
  return {
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 200,
        height: 120,
        text: 'n1',
        'x-whiteboard': { facets: { [facetKey]: { kind } } },
      },
    ],
    edges: [],
  }
}

const shapeOf = (nodes: readonly SceneNode[]) =>
  nodes.find((n): n is Extract<SceneNode, { kind: 'shape' }> => n.kind === 'shape')

describe('a contributed shape', () => {
  it('draws the geometry its plugin registered, under a namespaced id', () => {
    const scene = layoutSpatialCanvas(
      canvasWith('demo.shape/v0', 'triangle'),
      baseOptions({
        shapeFacets: ['demo.shape/v0'],
        shapes: { 'demo.triangle': TRIANGLE },
      }),
    )

    // The scene carries the NAME, not the geometry: outlines derive from
    // bbox + id so `translateScene`/`scaleScene` need no knowledge of them.
    expect(shapeOf(scene.nodes)?.shape).toBe('demo.triangle')
  })

  it('lays a node’s content out inside the contributed content box', () => {
    const scene = layoutSpatialCanvas(
      canvasWith('demo.shape/v0', 'triangle'),
      baseOptions({
        shapeFacets: ['demo.shape/v0'],
        shapes: { 'demo.triangle': TRIANGLE },
      }),
    )

    // Content has to start inside the triangle's declared content box
    // (100,60 → the lower-right quarter), not at the node's own origin.
    // Without the contribution the same block lays out at 8,18.
    const content = scene.nodes.filter((n) => n.kind !== 'shape' && 'bbox' in n)
    expect(content.length).toBeGreaterThan(0)
    for (const block of content) {
      expect(block.bbox.x).toBeGreaterThanOrEqual(100)
      expect(block.bbox.y).toBeGreaterThanOrEqual(60)
    }
  })

  it('cannot reach another plugin’s geometry by naming it in a payload', () => {
    // `demo` tries to draw itself as a diamond by writing `visual.diamond`
    // into its OWN facet. The namespace comes from the facet key, so this
    // composes `demo.visual.diamond` — unregistered, and the node degrades to
    // a plain rect.
    //
    // The bundled facet is closed against this by its enum schema instead
    // (its payload can only be one of five bare names), which is a different
    // mechanism and NOT what this case exercises — verified by mutation:
    // removing composition from the bundled branch leaves this green.
    const scene = layoutSpatialCanvas(
      canvasWith('demo.shape/v0', 'visual.diamond'),
      baseOptions({ shapeFacets: ['demo.shape/v0'] }),
    )

    expect(shapeOf(scene.nodes)?.shape).toBe('demo.visual.diamond')
    // Composed, but nothing answers to it — so nothing is drawn.
    expect(renderSceneToSvg(scene)).not.toContain('polygon')
  })

  it('leaves the shapes visual ships working, under their composed ids', () => {
    const scene = layoutSpatialCanvas(canvasWith('visual.shape/v0', 'diamond'), baseOptions())
    expect(shapeOf(scene.nodes)?.shape).toBe('visual.diamond')
  })

  it('is painted by the backend, which resolves the same table', () => {
    const scene = layoutSpatialCanvas(
      canvasWith('demo.shape/v0', 'triangle'),
      baseOptions({
        shapeFacets: ['demo.shape/v0'],
        shapes: { 'demo.triangle': TRIANGLE },
      }),
    )

    // The registry travels to BOTH ends, like `icons` already does: layout
    // uses it for the content box and edge anchoring, the backend to draw.
    // Without it here the node would paint as a plain rect.
    const svg = renderSceneToSvg(scene, { shapes: { 'demo.triangle': TRIANGLE } })
    expect(svg).toContain('200,0')
  })

  it('is MERGED over the built-ins, so passing a table keeps visual’s shapes', () => {
    // A caller supplying one shape must not lose the five that ship. Caught
    // by rendering a real canvas, not by a test: every case above passes
    // either only a contributed table or none, so a table that REPLACED the
    // built-ins looked correct from both sides.
    const scene = layoutSpatialCanvas(
      canvasWith('visual.shape/v0', 'diamond'),
      baseOptions({ shapes: { 'demo.triangle': TRIANGLE } }),
    )

    expect(shapeOf(scene.nodes)?.shape).toBe('visual.diamond')
    expect(renderSceneToSvg(scene, { shapes: { 'demo.triangle': TRIANGLE } })).toContain('polygon')
  })

  it('lets a caller override a built-in under its own id', () => {
    const scene = layoutSpatialCanvas(
      canvasWith('visual.shape/v0', 'diamond'),
      baseOptions({ shapes: { 'visual.diamond': TRIANGLE } }),
    )
    const svg = renderSceneToSvg(scene, { shapes: { 'visual.diamond': TRIANGLE } })
    // The triangle's own vertices, not the diamond's.
    expect(svg).toContain('200,0')
  })
})

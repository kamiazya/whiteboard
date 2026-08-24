// A plugin draws ON a node, not only the node's outline. The badge
// `visual.symbol` paints was composed here, inside the renderer, so a plugin
// wanting any mark of its own had no way to add one — and the renderer knew
// what a badge is, which is the plugin's business.
//
// Decorations COMPOSE: several plugins marking one node is a stack, not a
// conflict, so the only question is order and it answers by contribution
// order. That is what makes this seam cheaper than the silhouette one.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { BoundingBox, SceneNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({ fill: '#336699' }),
}

function baseOptions(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    // A real body: with an empty one there is no content node to order the
    // decoration against, so "after the node's own content" would be
    // asserted by nothing.
    parseBody: () => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'body' }] }],
    }),
    appearance: APPEARANCE,
    ...over,
  }
}

const canvasOf = (facets?: Record<string, unknown>): SpatialCanvas => ({
  nodes: [
    {
      id: 'n1',
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      text: 'n1',
      ...(facets === undefined ? {} : { 'x-whiteboard': { facets } }),
    },
  ],
  edges: [],
})

const kindsOf = (nodes: readonly SceneNode[]) => nodes.map((n) => n.kind)

describe('a contributed decoration', () => {
  it('is drawn, and after the node’s own content', () => {
    const scene = layoutSpatialCanvas(
      canvasOf(),
      baseOptions({
        decorations: [
          (_node, ctx) => [{ kind: 'glyph', bbox: { ...ctx.bounds, w: 8, h: 8 }, glyph: '★' }],
        ],
      }),
    )

    const kinds = kindsOf(scene.nodes)
    expect(kinds).toContain('glyph')
    expect(kinds).toContain('paragraph')
    // A mark ON a node paints over what it marks — so after the chrome AND
    // after the node's own content, not merely after the chrome.
    expect(kinds.indexOf('glyph')).toBeGreaterThan(kinds.indexOf('shape'))
    expect(kinds.indexOf('glyph')).toBeGreaterThan(kinds.indexOf('paragraph'))
  })

  it('is handed the node’s CONTENT box, so a silhouette insets it too', () => {
    const seen: BoundingBox[] = []
    layoutSpatialCanvas(
      canvasOf({ 'visual.shape/v0': { kind: 'diamond' } }),
      baseOptions({
        decorations: [
          (_node, ctx) => {
            seen.push(ctx.bounds)
            return []
          },
        ],
      }),
    )

    // A diamond's content box is the middle quarter — all four fields, since
    // an oversized box has the right origin and lets a decoration paint
    // outside the silhouette.
    expect(seen).toEqual([{ x: 50, y: 30, w: 100, h: 60 }])
  })

  it('is handed the resolved label appearance, so its ink can match the text', () => {
    const seen: string[] = []
    layoutSpatialCanvas(
      canvasOf(),
      baseOptions({
        decorations: [
          (_node, ctx) => {
            seen.push(String(ctx.label.fill))
            return []
          },
        ],
      }),
    )
    expect(seen).toEqual(['#336699'])
  })

  it('stacks several contributions in contribution order', () => {
    const scene = layoutSpatialCanvas(
      canvasOf(),
      baseOptions({
        decorations: [
          () => [{ kind: 'glyph', bbox: { x: 0, y: 0, w: 8, h: 8 }, glyph: 'A' }],
          () => [{ kind: 'glyph', bbox: { x: 0, y: 0, w: 8, h: 8 }, glyph: 'B' }],
        ],
      }),
    )
    const glyphs = scene.nodes.filter(
      (n): n is Extract<SceneNode, { kind: 'glyph' }> => n.kind === 'glyph',
    )
    expect(glyphs.map((g) => g.glyph)).toEqual(['A', 'B'])
  })

  it('still paints visual’s badge with nothing wired, since it is the default', () => {
    const scene = layoutSpatialCanvas(
      canvasOf({ 'visual.symbol/v0': { kind: 'emoji', char: '⭐' } }),
      baseOptions(),
    )
    const glyphs = scene.nodes.filter(
      (n): n is Extract<SceneNode, { kind: 'glyph' }> => n.kind === 'glyph',
    )
    expect(glyphs.map((g) => g.glyph)).toEqual(['⭐'])
  })
})

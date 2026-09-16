// ADR-0040 decision 6: a legend lists the values of every scoped-tag key the
// board's colour is CARRIED by, each with the swatch the boxes (or the
// edges) under that value are drawn in. Judged by the facet score, so a
// legend can never promise a distinction the drawing does not keep.
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { SpatialAppearanceResolver } from '../layout/nodes/spatial-appearance.js'
import { canvasLegend } from './canvas-legend.js'

const box = (id: string, extra: Partial<SpatialNode> = {}): SpatialNode =>
  textNode({ id, text: id, x: 0, y: 0, width: 100, height: 50, ...extra })
const edge = (
  id: string,
  from: string,
  to: string,
  extra: Partial<CanvasEdge> = {},
): CanvasEdge => ({
  id,
  from: { node: from },
  to: { node: to },
  ...extra,
})

/** Colours resolved the way a theme would, spelled so a test can read them back. */
const appearance: SpatialAppearanceResolver = {
  resolveNode: (node) => ({
    appearance:
      node.color === undefined
        ? { fill: 'fill-default', stroke: 'stroke-default' }
        : { fill: `fill-${node.color}`, stroke: `stroke-${node.color}` },
  }),
  resolveEdge: (element) => ({
    stroke:
      'color' in element && element.color !== undefined ? `edge-${element.color}` : 'edge-default',
  }),
  resolveLabel: () => ({ fill: '#303030' }),
}

describe('canvasLegend', () => {
  it('lists a carried key’s values with the box swatch each class is drawn in, the untagged class last', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        box('api', { tags: ['health:ok'], color: '4' }),
        box('db', { tags: ['health:failing'], color: '1' }),
        box('cache', { tags: ['health:ok'], color: '4' }),
        box('note'),
      ],
      edges: [],
    }
    expect(canvasLegend(canvas, appearance)).toEqual({
      keys: [
        {
          key: 'health',
          of: 'boxes',
          entries: [
            { value: 'failing', count: 1, swatch: { fill: 'fill-1', stroke: 'stroke-1' } },
            { value: 'ok', count: 2, swatch: { fill: 'fill-4', stroke: 'stroke-4' } },
            { value: '', count: 1, swatch: { fill: 'fill-default', stroke: 'stroke-default' } },
          ],
        },
      ],
      uncarried: { boxes: false, edges: false },
    })
  })

  it('answers nothing for a board whose colour is unused, and for one with no tags', () => {
    expect(canvasLegend({ nodes: [box('a'), box('b')], edges: [] }, appearance)).toBeUndefined()
    expect(
      canvasLegend(
        {
          nodes: [box('a', { tags: ['health:ok'] }), box('b', { tags: ['health:failing'] })],
          edges: [],
        },
        appearance,
      ),
    ).toBeUndefined()
  })

  it('colour spent with no key carrying it is one uncarried line, not a key', () => {
    const canvas: SpatialCanvas = {
      nodes: [box('a', { color: '1' }), box('b', { color: '2' })],
      edges: [edge('e', 'a', 'b', { color: '3' }), edge('f', 'b', 'a', { color: '5' })],
    }
    expect(canvasLegend(canvas, appearance)).toEqual({
      keys: [],
      uncarried: { boxes: true, edges: true },
    })
  })

  it('a frame or a stencil carrying the colour is not a legend key — only a scoped-tag key is', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'g', type: 'group', x: -10, y: -10, width: 300, height: 100 },
        box('a', { color: '1' }),
        box('b', { x: 500, color: '2' }),
      ],
      edges: [],
    }
    // Frame membership partitions a/b and colour is constant per class:
    // carried, but by nothing a legend can name a value of.
    expect(canvasLegend(canvas, appearance)).toBeUndefined()
  })

  it('the edges get their own key with line swatches, judged over the edges alone', () => {
    const canvas: SpatialCanvas = {
      nodes: [box('a'), box('b'), box('c')],
      edges: [
        edge('e1', 'a', 'b', { tags: ['link:ok'], color: '4' }),
        edge('e2', 'b', 'c', { tags: ['link:slow'], color: '1' }),
        edge('e3', 'c', 'a'),
      ],
    }
    expect(canvasLegend(canvas, appearance)).toEqual({
      keys: [
        {
          key: 'link',
          of: 'edges',
          entries: [
            { value: 'ok', count: 1, swatch: { stroke: 'edge-4' } },
            { value: 'slow', count: 1, swatch: { stroke: 'edge-1' } },
            { value: '', count: 1, swatch: { stroke: 'edge-default' } },
          ],
        },
      ],
      uncarried: { boxes: false, edges: false },
    })
  })
})

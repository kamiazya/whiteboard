// A frame's title is drawn ABOVE its border, outside every node rect, so a
// router that steers only round node rects draws straight through it. The
// title is measured text, and routing is measure-free, so the layout hands
// the measured boxes in: `routeEdge` steps round them, and the side search
// prices ink through them, so the two agree on what is in the way.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { interiorInk } from '../../test-utils/routing-metrics.js'
import { node } from '../../test-utils/spatial-node.js'
import { layoutSpatialCanvas } from '../spatial-canvas.js'
import { routeEdge } from './edge-router.js'

describe('a frame title in a route’s way', () => {
  it('is stepped round when the router is told where it is', () => {
    const nodes: SpatialNode[] = [node('a', 0, 0, 120, 80), node('b', 0, 300, 120, 80)]
    // The direct line runs down x=60, through this box.
    const title = { x: 20, y: 180, w: 200, h: 20 }
    const edge = { id: 'e', from: { node: 'a' }, to: { node: 'b' } }
    const { path } = routeEdge(nodes, edge, 'straight', undefined, undefined, undefined, [title])
    expect(interiorInk(path, title)).toBe(0)
  })

  it('is not crossed by a laid-out connection into the frame below', () => {
    // A note above a frame, wired to a member of it: the direct line drops
    // through the frame's title on its way down.
    const canvas: SpatialCanvas = {
      nodes: [
        node('above', 40, 0, 160, 80),
        groupNode({
          id: 'frame',
          x: 0,
          y: 200,
          width: 400,
          height: 200,
          label: 'Next actions agreed with the team',
        }),
        node('member', 40, 260, 160, 80),
      ],
      edges: [{ id: 'e', from: { node: 'above' }, to: { node: 'member' } }],
    }
    const scene = layoutSpatialCanvas(canvas, {
      measure: createFakeMeasure(),
      parseBody: (text: string) => ({
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
      }),
      appearance: {
        resolveNode: () => ({}),
        resolveEdge: () => ({ stroke: '#606060' }),
        resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
      },
    })
    const title = scene.nodes.find(
      (n): n is TextRunNode => n.kind === 'textRun' && (n as TextRunNode).annotates?.id === 'frame',
    )
    const edge = scene.nodes.find((n) => n.kind === 'edge' && n.id === 'e')
    expect(title).toBeDefined()
    expect(edge?.kind).toBe('edge')
    if (edge?.kind !== 'edge' || title === undefined) return
    expect(interiorInk(edge.path, title.bbox)).toBe(0)
  })
})

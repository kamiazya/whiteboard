// `wb_scene_render` reports the size of what it drew. It was measuring the
// canvas's NODES, so anything drawn outside a node's own box — an edge
// routed around one, which the router now does deliberately — fell outside
// the reported size, and a consumer sizing a viewport by it clipped the
// drawing.
import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { composeCanvasScene, computeSceneDimensions } from './compose-canvas-scene.js'

const canvas = (nodes: unknown[], edges: unknown[] = []): SpatialCanvas =>
  ({ nodes, edges }) as unknown as SpatialCanvas

const node = (id: string, x: number, y: number, w = 100, h = 60) => ({
  id,
  type: 'text' as const,
  x,
  y,
  width: w,
  height: h,
  text: id,
})

const dimensionsOf = (c: SpatialCanvas) =>
  computeSceneDimensions(composeCanvasScene(c, constantRatioMeasureText))

describe('computeSceneDimensions', () => {
  it('an empty canvas has no size', () => {
    expect(dimensionsOf(canvas([]))).toEqual({ width: 0, height: 0 })
  })

  it('measures to the far edge of the nodes', () => {
    expect(dimensionsOf(canvas([node('a', 0, 0), node('b', 200, 140)]))).toEqual({
      width: 300,
      height: 200,
    })
  })

  it('includes an edge routed outside every node box', () => {
    // b sits directly below a, so the route between them cannot run straight:
    // it steps around, and the step is drawn beyond both boxes.
    const withEdge = canvas(
      [node('a', 0, 0, 200, 100), node('b', 40, 140, 200, 100)],
      [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    )
    const nodesOnly = canvas([node('a', 0, 0, 200, 100), node('b', 40, 140, 200, 100)])
    const withEdgeSize = dimensionsOf(withEdge)
    const nodesOnlySize = dimensionsOf(nodesOnly)
    // Whatever the route is, the reported size must cover it.
    expect(withEdgeSize.width).toBeGreaterThanOrEqual(nodesOnlySize.width)
    expect(withEdgeSize.height).toBeGreaterThanOrEqual(nodesOnlySize.height)
    const scene = composeCanvasScene(withEdge, constantRatioMeasureText)
    for (const sceneNode of scene.nodes) {
      if (sceneNode.kind !== 'edge') continue
      for (const point of sceneNode.path) {
        expect(point.x).toBeLessThanOrEqual(withEdgeSize.width)
        expect(point.y).toBeLessThanOrEqual(withEdgeSize.height)
      }
    }
  })
})

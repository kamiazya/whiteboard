import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { routeEdge } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, test } from 'vitest'
import { composeCanvasScene, computeCanvasDimensions } from './compose-canvas-scene.js'
import { fallbackMeasureText } from './fallback-measure.js'

describe('composeCanvasScene', () => {
  test('translates a text node body by its own (x, y)', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'n1', type: 'text', x: 10, y: 20, width: 100, height: 50, text: 'hello world' },
      ],
      edges: [],
    }

    const scene = composeCanvasScene(canvas, fallbackMeasureText)

    expect(scene.nodes).toHaveLength(1)
    const [paragraph] = scene.nodes
    if (!('bbox' in paragraph)) throw new Error('expected a bbox-carrying scene node')
    expect(paragraph.kind).toBe('paragraph')
    expect(paragraph.bbox.x).toBe(10)
    expect(paragraph.bbox.y).toBe(20)
  })

  test('degrades a file/link/group node to a placeholder box at its own bbox', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'n1', type: 'file', x: 5, y: 6, width: 40, height: 30, file: 'a.png' },
        { id: 'n2', type: 'link', x: 1, y: 2, width: 10, height: 10, url: 'https://example.com' },
        { id: 'n3', type: 'group', x: 0, y: 0, width: 200, height: 200 },
      ],
      edges: [],
    }

    const scene = composeCanvasScene(canvas, fallbackMeasureText)

    expect(scene.nodes).toHaveLength(3)
    for (const [index, node] of canvas.nodes.entries()) {
      const sceneNode = scene.nodes[index]
      if (!('bbox' in sceneNode)) throw new Error('expected a bbox-carrying scene node')
      expect(sceneNode.kind).toBe('group')
      expect(sceneNode.bbox).toEqual({ x: node.x, y: node.y, w: node.width, h: node.height })
    }
  })

  test('a malformed text body degrades to a placeholder instead of throwing', () => {
    // An unbalanced/invalid fence-like construct that the closed mdast
    // subset's schema rejects after remark parses it into a shape
    // mdastRootSchema does not accept.
    const canvas: SpatialCanvas = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          text: '<div><span></div>',
        },
      ],
      edges: [],
    }

    expect(() => composeCanvasScene(canvas, fallbackMeasureText)).not.toThrow()
  })

  test('edge scene nodes are not translated a second time on top of routeEdge', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'group', x: 0, y: 0, width: 50, height: 50 },
        { id: 'b', type: 'group', x: 200, y: 200, width: 50, height: 50 },
      ],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
    }

    const scene = composeCanvasScene(canvas, fallbackMeasureText)
    const edgeNode = scene.nodes.find((n) => n.kind === 'edge')
    const expected = routeEdge(canvas.nodes, canvas.edges[0])

    expect(edgeNode).toEqual(expected)
  })
})

describe('computeCanvasDimensions', () => {
  test('returns a zero-sized default for an empty canvas', () => {
    expect(computeCanvasDimensions([])).toEqual({ width: 0, height: 0 })
  })

  test('returns the union bounding box over multiple nodes', () => {
    const dims = computeCanvasDimensions([
      { id: 'a', type: 'group', x: 0, y: 0, width: 50, height: 50 },
      { id: 'b', type: 'group', x: 100, y: 100, width: 50, height: 50 },
    ])
    expect(dims).toEqual({ width: 150, height: 150 })
  })
})

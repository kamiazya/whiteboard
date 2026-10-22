import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, it } from 'vitest'
import { anchorBox, viewportRevealing } from './reveal-anchor.js'

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 100, y: 200, width: 120, height: 60, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 500, width: 100, height: 50, text: 'b' }),
  ],
  edges: [],
}
const noPath = () => undefined

it('boxes a node, a set of nodes, a region, a spot and an edge path', () => {
  expect(anchorBox({ kind: 'spatial', nodeId: 'a', x: 0, y: 0 }, canvas, noPath)).toEqual({
    x: 100,
    y: 200,
    width: 120,
    height: 60,
  })
  expect(
    anchorBox(
      { kind: 'spatial', nodeIds: ['a', 'b'], x: 0, y: 0, width: 1, height: 1 },
      canvas,
      noPath,
    ),
  ).toEqual({ x: 100, y: 200, width: 400, height: 350 })
  expect(
    anchorBox({ kind: 'spatial', x: 50, y: 60, width: 30, height: 40 }, canvas, noPath),
  ).toEqual({ x: 50, y: 60, width: 30, height: 40 })
  const spot = anchorBox({ kind: 'spatial', x: 50, y: 60 }, canvas, noPath)
  expect(spot && spot.x + spot.width / 2).toBe(50)
  expect(spot && spot.y + spot.height / 2).toBe(60)
  expect(
    anchorBox({ kind: 'spatial', edgeId: 'e', x: 0, y: 0 }, canvas, () => [
      { x: 10, y: 10 },
      { x: 90, y: 40 },
    ]),
  ).toEqual({ x: 10, y: 10, width: 80, height: 30 })
})

it('has no box for the document, a note passage, or something that is gone', () => {
  expect(anchorBox({ kind: 'document' }, canvas, noPath)).toBeNull()
  expect(
    anchorBox({ kind: 'text', quote: { exact: 'x' }, start: 0, end: 1 }, canvas, noPath),
  ).toBeNull()
  expect(anchorBox({ kind: 'spatial', nodeId: 'gone', x: 0, y: 0 }, canvas, noPath)).toBeNull()
})

it('leaves a visible box alone and centres a hidden one', () => {
  const size = { width: 800, height: 600 }
  const view = { x: 0, y: 0, zoom: 1 }
  expect(viewportRevealing({ x: 100, y: 100, width: 50, height: 50 }, view, size)).toBeUndefined()
  const at = viewportRevealing({ x: 4000, y: 3000, width: 100, height: 60 }, view, size)
  expect(at).toEqual({ x: 4050 - 400, y: 3030 - 300, zoom: 1 })
  expect(viewportRevealing({ x: 4000, y: 3000, width: 1, height: 1 }, view, null)).toBeUndefined()
})

// An edge's stored bends, end to end through the whole layout —
// `bend-route.test.ts` holds the route itself, and this proves it reaches a
// composed scene with no option passed and nothing contributed.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const options: SpatialLayoutOptions = {
  measure: createFakeMeasure(),
  appearance: {
    resolveNode: () => ({ appearance: { fill: '#fff', stroke: '#000' } }),
    resolveEdge: () => ({ stroke: '#000' }),
    resolveLabel: () => ({ fill: '#000', fontFamily: 'x' }),
  },
}

const BEND = { x: 60, y: 400 }

const board = (bends?: { x: number; y: number }[]): SpatialCanvas => ({
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'a' },
    { id: 'b', type: 'text', x: 500, y: 0, width: 120, height: 60, text: 'b' },
  ],
  edges: [
    {
      id: 'e',
      from: { node: 'a' },
      to: { node: 'b' },
      ...(bends === undefined ? {} : { bends }),
    },
  ],
})

const edgeOf = (canvas: SpatialCanvas): ResolvedEdgeNode | undefined =>
  layoutSpatialCanvas(canvas, options).nodes.find(
    (node): node is ResolvedEdgeNode => node.kind === 'edge',
  )

const passesThrough = (canvas: SpatialCanvas): boolean =>
  (edgeOf(canvas)?.path ?? []).some((point) => point.x === BEND.x && point.y === BEND.y)

describe('an edge that stores its own bends', () => {
  it('is drawn through them, with no option passed and nothing contributed', () => {
    expect(passesThrough(board([BEND]))).toBe(true)
  })

  it('leaves an edge with no bends to the built-in routing', () => {
    expect(passesThrough(board())).toBe(false)
  })

  it('draws a computed route rather than half a path when a bend is unserializable', () => {
    const edge = edgeOf(board([{ x: BEND.x, y: Number.NaN }]))
    expect(edge?.path.length).toBeGreaterThanOrEqual(2)
    expect(edge?.path.some((point) => point.y === BEND.y)).toBe(false)
  })
})

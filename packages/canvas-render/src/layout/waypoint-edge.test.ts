// The router contribution point, end to end through the BUNDLED plugin —
// `contributed-router.test.ts` proves the seam against a fixture, and this
// proves a real plugin reaches it with the layout's default options.

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

const board = (facets: Record<string, unknown> | undefined): SpatialCanvas => ({
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'a' },
    { id: 'b', type: 'text', x: 500, y: 0, width: 120, height: 60, text: 'b' },
  ],
  edges: [
    {
      id: 'e',
      fromNode: 'a',
      toNode: 'b',
      ...(facets === undefined ? {} : { 'x-whiteboard': { facets } }),
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
  it('is drawn through them by the bundled plugin, with no option passed', () => {
    expect(passesThrough(board({ 'visual.path/v0': { waypoints: [BEND] } }))).toBe(true)
  })

  it('leaves an edge with no bends to the built-in routing', () => {
    expect(passesThrough(board(undefined))).toBe(false)
  })

  it('draws the built-in route rather than half a path when the payload is refused', () => {
    const edge = edgeOf(board({ 'visual.path/v0': { waypoints: [{ x: BEND.x }] } }))
    expect(edge?.path.length).toBeGreaterThanOrEqual(2)
    expect(edge?.path.some((point) => point.y === BEND.y)).toBe(false)
  })
})

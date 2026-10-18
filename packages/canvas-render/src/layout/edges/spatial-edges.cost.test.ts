// What the side-choice search costs one layout when edges carry their stored
// bends. A bent edge keeps up to MAX_BENDS of its authored points and is drawn
// through them without routing, but its segments still feed the search's
// scorer: the pairwise build sweeps every segment against every other whose
// box it meets, and every trial re-scores the pairs of each edge it touched.
// Bends zigzagging across one square make every segment's box meet every
// other's, so both are quadratic in the segment count.
//
// Work, not wall time. The trial path's narrow phase is `pairScore`'s call of
// `scoreQuantizedSegmentPair`, counted through the module boundary; the
// build's is inside the sweep module, so it is counted by the coordinate reads
// the sweep makes of the bend points, eight per narrow-phase test.

import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { layoutSpatialEdges } from '../spatial-canvas.js'

const work = vi.hoisted(() => ({ trialTests: 0, builds: 0, inBuild: false, buildReads: 0 }))

vi.mock('./edge-crossing-sweep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./edge-crossing-sweep.js')>()
  return {
    ...actual,
    scoreQuantizedSegmentPair: (...args: Parameters<typeof actual.scoreQuantizedSegmentPair>) => {
      work.trialTests++
      return actual.scoreQuantizedSegmentPair(...args)
    },
    buildPairwiseScores: (...args: Parameters<typeof actual.buildPairwiseScores>) => {
      work.builds++
      work.inBuild = true
      try {
        return actual.buildPairwiseScores(...args)
      } finally {
        work.inBuild = false
      }
    },
  }
})

const BENDS = 64

/** A point whose coordinates count their reads while the sweep runs. */
function countedPoint(x: number, y: number): { x: number; y: number } {
  return {
    get x() {
      if (work.inBuild) work.buildReads++
      return x
    },
    get y() {
      if (work.inBuild) work.buildReads++
      return y
    },
  }
}

const box = (id: string, x: number, y: number): SpatialNode =>
  textNode({ id, x, y, width: 100, height: 100, text: '' })

/**
 * `edges` edges between two boxes, each through MAX_BENDS stored bends that
 * zigzag between the corners of one 1000px square — offset a little per edge
 * so no two segments coincide, which keeps every pair a real crossing test
 * rather than a collinear overlap.
 */
function zigzagBoard(edges: number): SpatialCanvas {
  const routed: CanvasEdge[] = Array.from({ length: edges }, (_, i) => ({
    id: `e${i}`,
    from: { node: 'A' },
    to: { node: 'B' },
    bends: Array.from({ length: BENDS }, (_, k) =>
      countedPoint((k % 2) * 1000 + i * 0.25, ((k >> 1) % 2) * 1000 + i * 0.5),
    ),
  }))
  return {
    nodes: [box('A', -200, 400), box('B', 1100, 400)],
    edges: routed,
    facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
  }
}

describe('side-choice search cost per layout', () => {
  it('bounds the segment pairs one layout scores for edges through stored bends', () => {
    const board = zigzagBoard(50)
    Object.assign(work, { trialTests: 0, builds: 0, inBuild: false, buildReads: 0 })
    const scene = layoutSpatialEdges(board, {
      measure: createFakeMeasure(),
      parseBody: () => ({ type: 'root', children: [] }),
      appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
    })

    // The subject is present: every edge is drawn through all its bends, and
    // the search both built its pair scores and tried trials.
    const drawn = scene.filter((n) => n.kind === 'edge')
    expect(drawn).toHaveLength(50)
    for (const edge of drawn) expect(edge.path.length).toBe(BENDS + 2)
    expect(work.builds).toBeGreaterThan(0)
    expect(work.trialTests).toBeGreaterThan(0)
    // Unbounded, this board makes 4.1e8 narrow-phase tests in one layout,
    // nearly all of them re-scoring trials, and the count grows with the
    // square of the edges: 7.5e7 at 20 of them.
    const narrowTests = work.trialTests + work.buildReads / 8
    expect(narrowTests).toBeLessThanOrEqual(80_000_000)
  }, 300_000)
})

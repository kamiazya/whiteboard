// What line jumps leave unhopped, read off the whole layout through the core.
//
// The routing scoreboard (`edge-routing-quality.rust.test.ts`) routes edge by
// edge and never asks for hops, so this column left it when the TypeScript
// jumps were deleted. It is counted here, through the one call that draws
// them: `layoutSpatialCanvas`, with the canvas's `visual.edges` facet asking
// for arcs.
//
// Hops are OPT-IN, and a comparison that forgets it reads as a defect: the
// same corpora laid out with no `lineJumps` draw no hop at all, so every
// crossing counts as unhopped. That is the board's choice, not the core's —
// the deleted TypeScript composer resolved `lineJumps ?? 'none'` too — and the
// first describe pins it so the default cannot move silently either way.
//
// Pinned EXACTLY, like every scoreboard here: an improvement is as loud as a
// regression.
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'
import { constantRatioMeasureText } from '../measure.js'
import { latticeLayouts, type RoutingCase, syntheticLayouts } from '../test-utils/routing-corpus.js'
import { crossings, unhoppedCrossings } from '../test-utils/routing-metrics.js'
import { oracleLayoutCore } from '../test-utils/wasm/oracle-layout-core.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'

const appearance = createSpatialTheme({ mode: 'light' })

function canvasOf(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
  lineJumps: 'arc' | undefined,
): SpatialCanvas {
  return {
    nodes: [...nodes],
    edges: [...edges],
    facets: {
      'visual.edges/v0':
        lineJumps === undefined ? { routing: 'orthogonal' } : { routing: 'orthogonal', lineJumps },
    },
  }
}

/** Crossings, hops drawn, and crossings no hop covers, summed over `cases`. */
function score(cases: readonly RoutingCase[], lineJumps: 'arc' | undefined) {
  let crossingCount = 0
  let hops = 0
  let unhopped = 0
  for (const testCase of cases) {
    const scene = layoutSpatialCanvas(canvasOf(testCase.nodes, testCase.edges, lineJumps), {
      core: oracleLayoutCore(),
      measure: constantRatioMeasureText,
      appearance,
    })
    const edges = scene.nodes.filter((n): n is ResolvedEdgeNode => n.kind === 'edge')
    const paths = edges.map((e) => e.path)
    const drawn = edges.map((e) => (e.jumps ?? []).map((j) => ({ x: j.x, y: j.y })))
    crossingCount += crossings(paths)
    hops += drawn.reduce((sum, points) => sum + points.length, 0)
    unhopped += unhoppedCrossings(paths, drawn)
  }
  return { crossings: crossingCount, hops, unhoppedCrossings: unhopped }
}

describe('line jumps are opt-in', () => {
  it('draws no hop on a board whose edges facet names none', { timeout: 180_000 }, () => {
    // `crossings` proves the corpus still crosses: zero hops over a board with
    // nothing to hop would pass vacuously.
    expect(score(syntheticLayouts(2000), undefined)).toEqual({
      crossings: 352,
      hops: 0,
      unhoppedCrossings: 365,
    })
  })
})

describe('line jumps across the routing corpora', () => {
  it('leaves few crossings unhopped on the synthetic corpus', { timeout: 180_000 }, () => {
    // The same 9 the TypeScript jumps left over these routes before S18h3
    // deleted them: `crossings` equals the routing scoreboard's pin, so the
    // core draws the routes that scoreboard judges.
    expect(score(syntheticLayouts(2000), 'arc')).toEqual({
      crossings: 352,
      hops: 356,
      unhoppedCrossings: 9,
    })
  })

  it('leaves few crossings unhopped on the lattice corpus', { timeout: 180_000 }, () => {
    // The TypeScript's 2 likewise.
    expect(score(latticeLayouts(400), 'arc')).toEqual({
      crossings: 323,
      hops: 415,
      unhoppedCrossings: 2,
    })
  })
})

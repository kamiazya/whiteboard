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

const work = vi.hoisted(() => ({
  trialTests: 0,
  builds: 0,
  inBuild: false,
  buildReads: 0,
  routes: 0,
  rectVisits: 0,
  placementDepth: 0,
  placementVisits: 0,
  trialAttempts: 0,
}))

// What a trial pays outside the segment pairs: every edge it touched is
// routed again past every node, and re-scored against every node's box.
vi.mock('./edge-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./edge-router.js')>()
  return {
    ...actual,
    routeEdge: (...args: Parameters<typeof actual.routeEdge>) => {
      work.routes++
      work.rectVisits += args[4]?.length ?? args[0].length
      return actual.routeEdge(...args)
    },
  }
})

vi.mock('./edge-rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./edge-rules.js')>()
  return {
    ...actual,
    selfPenalty: (...args: Parameters<typeof actual.selfPenalty>) => {
      const [path, foreign, borders = []] = args
      work.rectVisits += (foreign.length + borders.length) * Math.max(0, path.length - 1)
      return actual.selfPenalty(...args)
    },
  }
})

// The anchor placement's member visits: every comparison or rank test it
// makes reads a tangent coordinate, so while placement runs each coordinate
// is handed back as a number that counts its reads. Outside placement (the
// router reads the same helper) it is a plain number.
vi.mock('./edge-geometry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./edge-geometry.js')>()
  return {
    ...actual,
    tangentCoordinate: (...args: Parameters<typeof actual.tangentCoordinate>) => {
      const value = actual.tangentCoordinate(...args)
      if (work.placementDepth === 0) return value
      return {
        valueOf() {
          work.placementVisits++
          return value
        },
      } as unknown as number
    },
  }
})

vi.mock('./edge-anchors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./edge-anchors.js')>()
  const placing =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      work.placementDepth++
      try {
        return fn(...args)
      } finally {
        work.placementDepth--
      }
    }
  return {
    ...actual,
    buildAnchorGroups: placing(actual.buildAnchorGroups),
    patchAnchorGroups: placing(actual.patchAnchorGroups),
    computeAnchorsFor: placing(actual.computeAnchorsFor),
    // Asked once per trial or repair candidate, before any of its work.
    patchWork: (...args: Parameters<typeof actual.patchWork>) => {
      work.trialAttempts++
      return actual.patchWork(...args)
    },
  }
})

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

function resetWork(): void {
  Object.assign(work, {
    trialTests: 0,
    builds: 0,
    inBuild: false,
    buildReads: 0,
    routes: 0,
    rectVisits: 0,
    placementDepth: 0,
    placementVisits: 0,
    trialAttempts: 0,
  })
}

function layoutEdges(board: SpatialCanvas) {
  return layoutSpatialEdges(board, {
    measure: createFakeMeasure(),
    parseBody: () => ({ type: 'root', children: [] }),
    appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
  })
}

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
    resetWork()
    const scene = layoutEdges(board)

    // The subject is present: every edge is drawn through all its bends, and
    // the search both built its pair scores and tried trials.
    const drawn = scene.filter((n) => n.kind === 'edge')
    expect(drawn).toHaveLength(50)
    for (const edge of drawn) expect(edge.path).toHaveLength(BENDS + 2)
    expect(work.builds).toBeGreaterThan(0)
    expect(work.trialTests).toBeGreaterThan(0)
    // Unbounded, this board makes 4.1e8 narrow-phase tests in one layout,
    // nearly all of them re-scoring trials, and the count grows with the
    // square of the edges: 7.5e7 at 20 of them.
    const narrowTests = work.trialTests + work.buildReads / 8
    expect(narrowTests).toBeLessThanOrEqual(80_000_000)
  }, 300_000)
})

const sized = (id: string, x: number, y: number, width: number, height: number): SpatialNode =>
  textNode({ id, x, y, width, height, text: '' })

const ORTHOGONAL = { 'visual.edges/v0': { routing: 'orthogonal' } } as const

/** `count` edges between the same two side-by-side boxes, no side named. */
function parallelBoard(count: number): SpatialCanvas {
  return {
    nodes: [sized('A', 0, 0, 120, 60), sized('B', 600, 0, 120, 60)],
    edges: Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      from: { node: 'A' },
      to: { node: 'B' },
    })),
    facets: ORTHOGONAL,
  }
}

/**
 * `count` sources in a column, each wired into the same side of one tall
 * hub, beside `bystanders` unconnected boxes far off to the right.
 */
function hubBoard(count: number, bystanders: number): SpatialCanvas {
  const columns = Math.ceil(Math.sqrt(bystanders))
  return {
    nodes: [
      sized('hub', 2000, 0, 200, 2000),
      ...Array.from({ length: count }, (_, i) => sized(`s${i}`, 0, i * 80, 120, 60)),
      ...Array.from({ length: bystanders }, (_, i) =>
        sized(`b${i}`, 10_000 + (i % columns) * 200, Math.floor(i / columns) * 200, 120, 60),
      ),
    ],
    edges: Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      from: { node: `s${i}` },
      to: { node: 'hub' },
    })),
    facets: ORTHOGONAL,
  }
}

/**
 * `count` edges from a box to a member of its width flush with its bottom,
 * the member's bottom side named: the ends meet on the shared border, so
 * edges collide. (Boxes that merely touch are drawn as a contact mark and
 * never reach the search.)
 */
function flushBoard(count: number): SpatialCanvas {
  return {
    nodes: [sized('A', 0, 0, 200, 200), sized('B', 0, 100, 200, 100)],
    edges: Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      from: { node: 'A' },
      to: { node: 'B', side: 'bottom' as const },
    })),
    facets: ORTHOGONAL,
  }
}

/**
 * `flushBoard(count)` beside `pairs` pairs of side-by-side boxes far off,
 * two edges each: edges the repair never touches, which a candidate's anchor
 * pass would re-place all of if it rebuilt the partition.
 */
function flushBesideBystanders(count: number, pairs: number): SpatialCanvas {
  const flush = flushBoard(count)
  return {
    ...flush,
    nodes: [
      ...flush.nodes,
      ...Array.from({ length: pairs }, (_, k) => [
        sized(`c${k}`, 5000 + (k % 20) * 600, Math.floor(k / 20) * 200, 120, 60),
        sized(`d${k}`, 5300 + (k % 20) * 600, Math.floor(k / 20) * 200, 120, 60),
      ]).flat(),
    ],
    edges: [
      ...flush.edges,
      ...Array.from({ length: pairs * 2 }, (_, i) => ({
        id: `b${i}`,
        from: { node: `c${i >> 1}` },
        to: { node: `d${i >> 1}` },
      })),
    ],
  }
}

describe('side-choice search cost on boards that crowd one side', () => {
  it('bounds the work trials do re-anchoring every edge of a shared side', () => {
    resetWork()
    const scene = layoutEdges(parallelBoard(200))
    expect(scene.filter((n) => n.kind === 'edge')).toHaveLength(200)
    // The subject is present: the search re-routed the shared sides' edges
    // trial after trial.
    expect(work.routes).toBeGreaterThan(2000)
    // Every trial re-places the two groups of 200 ends, and a rank counted
    // by scanning the group per member made that 2.5e7 visits; by binary
    // search over the sorted coordinates, 1.0e6.
    expect(work.placementVisits).toBeLessThanOrEqual(4_000_000)
    // Each touched edge's pair lookups are charged to the search's share of
    // the trial account, which stops this search after 126 of the 182 trials
    // it would otherwise ask for.
    expect(work.trialAttempts).toBeLessThanOrEqual(150)
  }, 300_000)

  it('bounds the work trials do routing and scoring past every node', () => {
    resetWork()
    const scene = layoutEdges(hubBoard(200, 1800))
    expect(scene.filter((n) => n.kind === 'edge')).toHaveLength(200)
    expect(work.routes).toBeGreaterThan(200)
    // Each trial touches all 200 edges into the hub's side, and each touched
    // edge is re-scored against all 2001 boxes per segment. Uncharged, the
    // search ran every trial it had: 6.4e8 visits. Charged to the search's
    // share of the layout's trial account, 6.4e7.
    expect(work.rectVisits).toBeLessThanOrEqual(150_000_000)
    // Once the account refuses a trial the search stops: 30 trials asked
    // for. Going on to every remaining candidate asks for 375, and each that
    // happens to fit the remainder is paid for again.
    expect(work.trialAttempts).toBeLessThanOrEqual(100)
  }, 300_000)

  it('bounds the anchor placement the coincident-ends repair makes', () => {
    resetWork()
    const scene = layoutEdges(flushBoard(400))
    const drawn = scene.filter((n) => n.kind === 'edge')
    expect(drawn).toHaveLength(400)
    // The subject is present: the repair re-sided collided edges into
    // visible routes.
    const visible = drawn.filter((n) => n.kind === 'edge' && n.path.length > 2)
    expect(visible.length).toBeGreaterThan(20)
    // A full anchor rebuild per candidate re-placed all 400 ends per side,
    // with each rank a scan of the group: 1.0e9 visits. Patched per
    // candidate and charged to the repair account, 1.4e7.
    expect(work.placementVisits).toBeLessThanOrEqual(50_000_000)
  }, 300_000)

  it('re-places only the groups a repair candidate moves', () => {
    resetWork()
    const scene = layoutEdges(flushBesideBystanders(100, 400))
    const drawn = scene.filter((n) => n.kind === 'edge')
    expect(drawn).toHaveLength(900)
    expect(drawn.filter((n) => n.kind === 'edge' && n.path.length > 2).length).toBeGreaterThan(50)
    // Each candidate patches the four groups its edge leaves and joins:
    // 1.4e6 visits. Rebuilding the partition per candidate re-places the
    // 800 bystander ends every time too: 1.0e7.
    expect(work.placementVisits).toBeLessThanOrEqual(4_000_000)
  }, 300_000)
})

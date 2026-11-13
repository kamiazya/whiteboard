/**
 * The boards `computeEdgeJumps` is recorded over: each a list of routed edges,
 * each an id and its drawn path, in document order.
 *
 * Beside routed boards, each helper of the jumps has boards built to land on
 * its boundaries: a waypoint a run continues through or not, a crossing on a
 * split, a split a clearance away from a crossing (exactly, and a hair either
 * side), a crossing handed to an earlier edge next to its own hops, and the
 * per-segment and per-scene hop caps met, passed and met part way.
 */

type Xy = readonly [number, number]
export interface Edge {
  readonly id: string
  readonly path: readonly Xy[]
}
export interface Board {
  readonly id: string
  readonly edges: readonly Edge[]
}

const edge = (id: string, ...path: Xy[]): Edge => ({ id, path })

/** A fixed linear congruential stream, so the scattered boards are data. */
function stream(start: number): () => number {
  let state = start >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** A waypoint between two points, or a reversal or repeat, as `kind` picks. */
function waypointsBetween(from: Xy, to: Xy, roll: number): Xy[] {
  const mid: Xy = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
  if (roll < 0.3) return [mid]
  if (roll < 0.36) return [to]
  if (roll < 0.42) return [mid, from]
  return []
}

/**
 * Orthogonal polylines on a grid of `step` px, so ends and splits often land
 * on one another's lines, with collinear waypoints, repeats and reversals
 * dropped in as a router (or an author) leaves them.
 */
function routedBoard(id: string, start: number, edges: number, span: number, step: number): Board {
  const next = stream(start)
  const snap = (v: number) => Math.round(v / step) * step
  const out: Edge[] = []
  for (let e = 0; e < edges; e++) {
    let at: Xy = [snap(next() * span), snap(next() * span)]
    const path: Xy[] = [at]
    const legs = 1 + Math.floor(next() * 4)
    for (let s = 0; s < legs; s++) {
      const length = snap((next() - 0.5) * span)
      const to: Xy = (s + e) % 2 === 0 ? [at[0] + length, at[1]] : [at[0], at[1] + length]
      path.push(...waypointsBetween(at, to, next()), to)
      at = to
    }
    out.push(edge(`${id}-${e}`, ...path))
  }
  return { id, edges: out }
}

/** A crossing exactly on a split of the later edge, the earlier, both, or neither. */
function splits(): Board {
  return {
    id: 'splits',
    edges: [
      edge('flat', [0, 0], [100, 0]),
      edge('split-later', [50, -50], [50, 0], [50, 50]),
      edge('split-earlier', [0, 200], [50, 200], [100, 200]),
      edge('straight-over', [50, 150], [50, 250]),
      edge('split-a', [0, 400], [50, 400], [100, 400]),
      edge('split-b', [50, 350], [50, 400], [50, 450]),
      edge('reversed', [200, -50], [200, 0], [200, -20]),
      edge('over-reversal', [150, 0], [250, 0]),
      edge('repeat', [300, -50], [300, 0], [300, 0], [300, 50]),
      edge('over-repeat', [250, 0], [350, 0]),
      edge('diagonal', [400, -50], [450, 0], [500, 50]),
      edge('over-diagonal', [400, 0], [500, 0]),
      edge('negative', [-50, -500], [-50, -300], [-50, -100]),
      edge('over-negative', [-100, -300], [0, -300]),
      edge('repeat-flat', [1000, 0], [1050, 0], [1050, 0], [1100, 0]),
      edge('over-repeat-flat', [1050, -50], [1050, 50]),
      edge('diagonal-then-vertical', [600, -50], [650, 0], [650, 50]),
      edge('over-dtv', [600, 0], [700, 0]),
      edge('diagonal-then-flat', [800, -50], [850, 0], [900, 0]),
      edge('over-dtf', [850, -40], [850, 40]),
      edge('negative-back', [-500, -50], [-300, -50], [-100, -50]),
      edge('over-negative-back', [-300, -100], [-300, 0]),
    ],
  }
}

/** The hop's clearance from a split of the later edge, at `d` px, on exact power-of-two runs. */
function clearances(): Board {
  const offsets = [5, 6, 6 - 1e-9, 6 - 2e-9, 6 - 5e-10, 6 + 1e-9, 7, -6, -(6 - 1e-9), -(6 - 2e-9)]
  const edges: Edge[] = []
  offsets.forEach((d, i) => {
    const x = i * 200
    edges.push(edge(`under-${i}`, [x - 64, 0], [x + 64, 0]))
    edges.push(edge(`split-${i}`, [x, -64], [x, d], [x, 64]))
    edges.push(edge(`under2-${i}`, [x - 64, 1000], [x, 1000], [x + 64, 1000]))
    edges.push(edge(`split2-${i}`, [x + d, 1000 - 64], [x + d, 1000 + 64]))
    edges.push(edge(`split3-${i}`, [x - 32 + d, 900], [x + d, 1100], [x + d + 64, 1100]))
  })
  // A crossing handed to an earlier run exactly the slack from either end.
  const slack = 6 - 1e-9
  for (const [i, y] of [16 - slack, slack].entries()) {
    const x = 2000 + i * 100
    edges.push(edge(`post-${i}`, [x, 0], [x, 16]))
    edges.push(edge(`split-at-slack-${i}`, [x - 50, y], [x, y], [x + 50, y]))
  }
  return { id: 'clearances', edges }
}

/**
 * An earlier edge with a hop of its own at x = 100, then a later edge whose
 * split lands on it `d` px away: the hand-over keeps the new hop, drops it, or
 * would trade one for the other.
 */
function handOvers(): Board {
  const offsets = [5, 9.99, 10, 10.01, 20, -5, -9.99, -10, -10.01, -20]
  const edges: Edge[] = []
  offsets.forEach((d, i) => {
    const y = i * 100
    edges.push(edge(`post-${i}`, [100, y - 40], [100, y + 40]))
    edges.push(edge(`rail-${i}`, [0, y], [300, y]))
    edges.push(edge(`split-${i}`, [100 + d, y - 30], [100 + d, y], [100 + d, y + 30]))
  })
  edges.push(edge('twice-a', [500, -40], [500, 0], [500, 40]))
  edges.push(edge('twice-b', [520, -40], [520, 0], [520, 40]))
  edges.push(edge('rail-late', [400, 0], [700, 0]))
  edges.push(edge('split-on-late', [600, -30], [600, 0], [600, 30]))
  edges.push(edge('rail-late', [400, 100], [700, 100]))
  edges.push(edge('split-on-dup', [650, 70], [650, 100], [650, 130]))
  return { id: 'hand-overs', edges }
}

/** `count` verticals at x = x0, x0 + gap, … spanning y in [y0, y0 + height]. */
function posts(prefix: string, count: number, x0: number, gap: number, y0: number, height: number) {
  return Array.from({ length: count }, (_, i) =>
    edge(`${prefix}${i}`, [x0 + i * gap, y0], [x0 + i * gap, y0 + height]),
  )
}

/**
 * One segment crossing more hops than it may draw, an earlier segment handed
 * more than it may draw, and crossings closer than an arc.
 */
function segmentCap(): Board {
  const handing = Array.from({ length: 70 }, (_, i) =>
    edge(`h${i}`, [20 + i * 12, 280], [20 + i * 12, 300], [20 + i * 12, 320]),
  )
  return {
    id: 'segment-cap',
    edges: [
      ...posts('p', 70, 20, 12, -10, 20),
      edge('long', [0, 0], [900, 0]),
      ...posts('q', 70, 20, 12, 90, 20),
      edge('long-split', [0, 100], [450, 100], [900, 100]),
      edge('hand-rail', [0, 300], [1000, 300]),
      ...handing,
      ...posts('s', 40, 2000, 6, 290, 20),
      edge('tight', [1990, 300], [2300, 300]),
    ],
  }
}

/**
 * The scene's 4096 hops spent: 33 on a short rail, then 63 rails of 64 each,
 * which leaves 31; a rail that wants 34 gets 20 of them through (all it
 * crosses), 32 splits handed to an untouched rail get the last 11 through, and
 * nothing after draws.
 */
function sceneCap(): Board {
  const edges = [edge('target', [0, 5000], [1000, 5000]), ...posts('v', 66, 0, 12, -10, 2000)]
  edges.push(edge('short', [-6, 0], [34 * 12 - 6, 0]))
  for (let r = 1; r <= 63; r++) edges.push(edge(`rail${r}`, [-6, r * 30], [70 * 12, r * 30]))
  edges.push(edge('handing', [-6, 1960], [20 * 12 - 6, 1960]))
  for (let k = 0; k < 32; k++) {
    const x = 10 + k * 20
    edges.push(edge(`split${k}`, [x, 4980], [x, 5000], [x, 5020]))
  }
  edges.push(edge('wants', [-6, 1975], [70 * 12, 1975]))
  edges.push(edge('after', [-6, 1985], [70 * 12, 1985]))
  return { id: 'scene-cap', edges }
}

/** The broad phase's work budget spent part way: hops before it stay, none after. */
function workBudget(): Board {
  const copies = Array.from({ length: 2000 }, (_, i) => edge(`c${i}`, [0, 0], [10, 0]))
  return {
    id: 'work-budget',
    edges: [
      edge('early-v', [500, -50], [500, 50]),
      edge('early-h', [450, 0], [550, 0]),
      ...copies,
      edge('late-v', [700, -50], [700, 50]),
      edge('late-h', [650, 0], [750, 0]),
    ],
  }
}

/**
 * A run whose far end is a repeated point, at 2^57, where coordinates fall on
 * a grid of 32: the crossing clears the run's end as the intersection measures
 * it, and not as a projection onto the segment does, so whether the repeat
 * joins the run decides which edge hops.
 */
function farRepeat(): Board {
  const at = 2 ** 57
  return {
    id: 'far-repeat',
    edges: [
      edge('slant', [-37.3, at + 1008 - 37.3 * 1.3], [51.1, at + 1008 + 51.1 * 1.3]),
      edge('repeat-end', [0, at], [0, at + 1024], [0, at + 1024]),
      edge('slant-x', [at + 1008 - 37.3 * 1.3, 1e4 - 37.3], [at + 1008 + 51.1 * 1.3, 1e4 + 51.1]),
      edge('repeat-end-x', [at, 1e4], [at + 1024, 1e4], [at + 1024, 1e4]),
    ],
  }
}

/** Paths a router would not draw: empty, a point, non-finite and far away. */
function degenerate(): Board {
  const n = Number.NaN
  const inf = Number.POSITIVE_INFINITY
  return {
    id: 'degenerate',
    edges: [
      edge('empty'),
      edge('point', [5, 5]),
      edge('nan', [n, 0], [100, 0]),
      edge('inf', [50, -inf], [50, 50]),
      edge('far-a', [1e15, 0], [1e15 + 100, 0]),
      edge('far-b', [1e15 + 50, -50], [1e15 + 50, 50]),
      edge('huge-a', [-1e308, 1], [1e308, 1]),
      edge('huge-b', [0, -1e308], [0, 1e308]),
      edge('tiny-split', [0, -100], [0, 0], [0, 1e-320], [0, 100]),
      edge('over-tiny', [-50, 1e-11], [0, 1e-11], [50, 1e-11]),
      edge('dup', [0, 0], [100, 0]),
      edge('dup', [50, -50], [50, 50]),
    ],
  }
}

/**
 * A board scaled by `factor`, a power of two, so its arithmetic is the same
 * but for overflow near the top of the range: the lengths and products the
 * hops are measured with overflow first, and past about 2^503 the crossing
 * test's own products do and no hop is found at all.
 */
function scaled(board: Board, factor: number, id: string): Board {
  const edges = board.edges.map(({ id: e, path }) =>
    edge(e, ...path.map(([x, y]): Xy => [x * factor, y * factor])),
  )
  return { id, edges }
}

export const BOARDS: readonly Board[] = [
  { id: 'cross', edges: [edge('h', [0, 0], [100, 0]), edge('v', [50, -50], [50, 50])] },
  routedBoard('routed-small', 1, 16, 400, 10),
  routedBoard('routed-dense', 2, 80, 300, 10),
  routedBoard('routed-wide', 3, 40, 4000, 20),
  routedBoard('routed-fine', 4, 60, 120, 2),
  splits(),
  clearances(),
  handOvers(),
  segmentCap(),
  sceneCap(),
  workBudget(),
  degenerate(),
  farRepeat(),
  scaled(handOvers(), 2 ** 500, 'hand-overs-huge'),
  scaled(splits(), 2 ** 502, 'splits-huge'),
  scaled(routedBoard('routed-top', 5, 30, 300, 10), 2 ** 503, 'routed-top'),
]

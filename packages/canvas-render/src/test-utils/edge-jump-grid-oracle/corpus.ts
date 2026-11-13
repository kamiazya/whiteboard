/**
 * The boards the line-jump grid is recorded over: each a list of edges, each
 * edge a list of straight runs `[ax, ay, bx, by]`, filed in that order.
 *
 * The grid's arithmetic is float geometry at its boundaries — a level whose
 * cell exactly holds an extent, a pad of `2^-20` cells, a cell line shifted by
 * a phase, a coarser level's bounds a sliver away — so most boards here are
 * built to land exactly on one of those, either side of it, or a ulp off.
 */

type Run = readonly [number, number, number, number]
export type Board = { readonly id: string; readonly edges: readonly (readonly Run[])[] }

/** A fixed linear congruential stream, so the scattered boards are data. */
function stream(start: number): () => number {
  let state = start >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const PAD = 2 ** -20
const PHASE = 0.381966
const up = (v: number) => v + Math.abs(v) * 2 ** -52
const down = (v: number) => v - Math.abs(v) * 2 ** -52

/** Orthogonal polylines over a board, as a router draws them. */
function routedBoard(id: string, start: number, edges: number, span: number): Board {
  const next = stream(start)
  const out: Run[][] = []
  for (let e = 0; e < edges; e++) {
    let x = Math.round(next() * span)
    let y = Math.round(next() * span)
    const runs: Run[] = []
    for (let s = 0; s < 1 + Math.floor(next() * 4); s++) {
      const length = Math.round((next() - 0.5) * span)
      const [nx, ny] = s % 2 === 0 ? [x + length, y] : [x, y + length]
      runs.push([x, y, nx, ny])
      ;[x, y] = [nx, ny]
    }
    out.push(runs)
  }
  return { id, edges: out }
}

/** Straight lines at every angle about a point, both ways round. */
function diagonals(id: string, cx: number, cy: number, lengths: readonly number[]): Board {
  const edges: Run[][] = []
  lengths.forEach((length, i) => {
    for (let k = 0; k < 12; k++) {
      const angle = (k * Math.PI) / 6 + i * 0.37
      const dx = Math.cos(angle) * length
      const dy = Math.sin(angle) * length
      edges.push([[cx - dx / 3, cy - dy / 3, cx + dx, cy + dy]])
    }
  })
  return { id, edges }
}

/** Extents exactly a power of four, and a ulp either side, at every scale. */
function levelBoundaries(): Board {
  const extents: number[] = [5e-324, 2 ** -61, 2 ** -60, 1e300, 2 ** 1022, 1.5 * 2 ** 1022]
  for (const k of [-30, -29, -1, 0, 1, 2, 5, 10]) {
    const cell = 4 ** k
    extents.push(cell, up(cell), down(cell), cell / 2, cell * 2)
  }
  const edges = extents.map((e, i): Run[] => [
    [i * 3, 0, i * 3 + e, 0],
    [0, i * 3, 0, i * 3 - e],
  ])
  return { id: 'level-boundaries', edges }
}

/** Runs of every level crossing one spot, coarse first and then fine first. */
function scales(id: string, coarseFirst: boolean): Board {
  const lengths = [0.5, 1, 3, 4, up(4), 16, 17, 100, 1000, 5000]
  const ordered = coarseFirst ? [...lengths].reverse() : lengths
  const edges = ordered.map((length, i): Run[] => [
    [50 - length / 2, 50 + (i % 3) - 1, 50 + length / 2, 50 - (i % 3) + 1],
    [50 + (i % 2), 50 - length / 2, 50 - (i % 2), 50 + length / 2],
  ])
  return { id, edges }
}

/**
 * A coarse run (cell 1024) and fine runs (cell 4) a coarse level's gap away
 * on each side of its bounds, exactly, a ulp nearer and a ulp further.
 */
function reachGaps(): Board {
  const gap = 1024 * PAD
  const coarse: Run = [0, 0, 1000, 600]
  const fine: Run[] = []
  for (const d of [gap, down(gap), up(gap)]) {
    fine.push([1000 + d, 300, 1003 + d, 301])
    fine.push([-3 - d, 300, -d, 299])
    fine.push([500, 600 + d, 501, 603 + d])
    fine.push([500, -d, 498, -3 - d])
  }
  return { id: 'reach-gaps', edges: [[coarse], ...fine.map((r) => [r]), [coarse]] }
}

/** Ends on a cell line, and a pad either side of it, at several cells. */
function onCellLines(): Board {
  const edges: Run[][] = []
  for (const cell of [4, 16, 64, 1024]) {
    const extent = cell * 0.75
    for (const k of [-2, 0, 1, 3]) {
      const line = cell * (k - PHASE)
      for (const off of [0, cell * PAD, -cell * PAD, up(cell * PAD), -up(cell * PAD)]) {
        edges.push([[line + off, k * 7, line + off + extent, k * 7]])
        edges.push([[k * 7, line + off, k * 7, line + off - extent]])
        edges.push([[line + off, line, line + off + extent, line + extent / 3]])
      }
    }
  }
  return { id: 'on-cell-lines', edges }
}

/** A routed board moved far along the number line, and outliers beside it. */
function far(): Board {
  const base = routedBoard('far', 7, 10, 400)
  const shifted = (dx: number, dy: number) =>
    base.edges.map((runs) =>
      runs.map(([ax, ay, bx, by]): Run => [ax + dx, ay + dy, bx + dx, by + dy]),
    )
  const outliers: Run[][] = [
    [[0, 1e300, 1e-18, 1e300]],
    [[1e300, 0, 1e300, 5]],
    [[-1e15, 3, -1e15 + 0.25, 3.5]],
    [
      [2 ** 53, 0, 2 ** 53 + 2, 0],
      [2 ** 53 + 2, 0, 2 ** 53 + 2, 8],
    ],
    [[0, 0, 1e308, 1e308]],
  ]
  return {
    id: 'far',
    edges: [...shifted(1e15, -1e12), ...shifted(2 ** 52, 2 ** 52), ...outliers, ...base.edges],
  }
}

/** Runs no crossing can use: zero, non-finite, and overflowing extents. */
function degenerate(): Board {
  const n = Number.NaN
  const inf = Number.POSITIVE_INFINITY
  const edges: Run[][] = [
    [
      [0, 0, 0, 0],
      [5, 5, 5, 5],
    ],
    [
      [n, 0, 10, 0],
      [0, n, 0, 10],
      [inf, 0, 0, 0],
      [0, 0, 0, -inf],
    ],
    [[-1.7e308, 0, 1.7e308, 0]],
    [
      [0, -5, 0, 5],
      [-5, 0, 5, 0],
    ],
  ]
  return { id: 'degenerate', edges }
}

/**
 * Enough copies of one run (cell 16, two cells each) that the broad phase's
 * work budget is spent part way. Copy `i` adds `3 + 2i` work, so 1999 copies
 * leave it at 3_999_999 and a last edge's second reach finds it spent; 2000
 * one-cell runs ahead of them, 2 work each, bring copy 1997 to exactly
 * 4_000_000, which is not yet spent, and copy 1998 past it.
 */
function budget(id: string, padding: number, tail: number): Board {
  const pads = Array.from({ length: padding }, (_, i): Run[] => [
    [90 + 1600 * i, 1e5, 100 + 1600 * i, 1e5],
  ])
  const copies = Array.from({ length: 1999 }, (): Run[] => [[0, 0, 10, 0]])
  const runs = Array.from({ length: tail }, (_, i): Run => [i * 40, 200, i * 40 + 7, 203])
  return { id, edges: [...pads, ...copies, ...(tail === 0 ? [] : [runs])] }
}

export const BOARDS: readonly Board[] = [
  { id: 'cross', edges: [[[0, 0, 100, 0]], [[50, -50, 50, 50]]] },
  routedBoard('routed-small', 1, 12, 800),
  routedBoard('routed-dense', 2, 60, 300),
  routedBoard('routed-wide', 3, 30, 20000),
  diagonals('diagonals', 100, 100, [30, 250, 3000]),
  diagonals('diagonals-off', -77.3, 19.9, [9, 61, 700]),
  levelBoundaries(),
  scales('scales-fine-first', false),
  scales('scales-coarse-first', true),
  reachGaps(),
  onCellLines(),
  far(),
  degenerate(),
  budget('budget-candidates', 2000, 0),
  budget('budget-reach', 0, 5),
]

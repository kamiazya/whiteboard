import { place, SegmentGrid } from '../../layout/edges/edge-jumps.js'
import { f64Hex } from '../render-oracle/scene-dump.js'
import { BOARDS, type Board } from './corpus.js'

/**
 * The recorded answers of the line-jump broad phase (`place` and
 * `SegmentGrid` in `layout/edges/edge-jumps.ts`), driven as
 * `computeEdgeJumps` drives it: every run placed and the grid built over them,
 * then edge by edge each run's reach asked, each run's candidates asked, and
 * the edge's runs filed — stopping, as it does, once the work budget is spent.
 *
 * Recorded per run: where it was placed (its level and bounds) or `null`; the
 * levels it reaches, each with its cells; its candidates as inclusive ranges
 * of filing indices, or `"spent"`; and the work the grid has counted after
 * each step. Every double is the hex of its IEEE bits, a NaN the canonical one.
 */

type Segment = Parameters<typeof place>[0]
type Placed = NonNullable<ReturnType<typeof place>>
type Reached = ReturnType<SegmentGrid['reach']>

const hex = (value: number): string => (Number.isNaN(value) ? '7ff8000000000000' : f64Hex(value))

/** The grid's running count of broad-phase work, read past its `private`. */
const workOf = (grid: SegmentGrid): number => (grid as unknown as { work: number }).work

type ReachWire = readonly (readonly [number, 0 | 1, readonly string[]])[]

/** One edge's step: each run's reach, then each run's candidates. */
interface EdgeStep {
  readonly reached: readonly (ReachWire | null)[]
  readonly workAfterReach: number
  readonly candidates: readonly (readonly (readonly [number, number])[] | 'spent' | null)[]
  readonly workAfter: number
}

export interface EdgeJumpGridRecord {
  readonly id: string
  readonly edges: readonly (readonly (readonly string[])[])[]
  readonly placed: readonly (readonly (readonly [number, ...string[]] | null)[])[]
  readonly steps: readonly EdgeStep[]
}

const reachWire = (reached: Reached): ReachWire =>
  reached.map(({ level, own, keys }) => [level.id, own ? 1 : 0, keys] as const)

/** Sorted indices as inclusive runs of consecutive ones. */
function ranges(indices: readonly number[]): [number, number][] {
  const out: [number, number][] = []
  for (const i of indices) {
    const last = out[out.length - 1]
    if (last !== undefined && last[1] + 1 === i) last[1] = i
    else out.push([i, i])
  }
  return out
}

function placedWire(p: Placed | undefined): readonly [number, ...string[]] | null {
  if (p === undefined) return null
  return [p.level, hex(p.minX), hex(p.maxX), hex(p.minY), hex(p.maxY)]
}

interface Drive {
  readonly grid: SegmentGrid
  readonly filed: Map<unknown, number>
}

/** One edge as `computeEdgeJumps` takes it; answers whether the budget is spent. */
function stepEdge(drive: Drive, runs: readonly (Placed | undefined)[], steps: EdgeStep[]): boolean {
  const { grid, filed } = drive
  const reached = runs.map((p) => (p === undefined ? undefined : grid.reach(p)))
  const workAfterReach = workOf(grid)
  let spent = false
  const candidates = reached.map((r) => {
    if (r === undefined || spent) return null
    const found = grid.candidates(r)
    if (found === undefined) {
      spent = true
      return 'spent' as const
    }
    return ranges(found.map((seg) => filed.get(seg) as number))
  })
  steps.push({
    reached: reached.map((r) => (r === undefined ? null : reachWire(r))),
    workAfterReach,
    candidates,
    workAfter: workOf(grid),
  })
  runs.forEach((p, i) => {
    const r = reached[i]
    if (p === undefined || r === undefined) return
    filed.set(p.seg, filed.size)
    grid.add(p.seg, r)
  })
  return spent
}

function record(board: Board): EdgeJumpGridRecord {
  const placed = board.edges.map((runs, edge) =>
    runs.map(([ax, ay, bx, by], run): Placed | undefined => {
      const seg: Segment = { a: { x: ax, y: ay }, b: { x: bx, y: by }, edge, first: run, last: run }
      return place(seg)
    }),
  )
  const grid = new SegmentGrid(placed.flat().filter((p): p is Placed => p !== undefined))
  const drive = { grid, filed: new Map<unknown, number>() }
  const steps: EdgeStep[] = []
  for (const runs of placed) if (stepEdge(drive, runs, steps)) break
  return {
    id: board.id,
    edges: board.edges.map((runs) => runs.map((run) => run.map(hex))),
    placed: placed.map((runs) => runs.map(placedWire)),
    steps,
  }
}

export const edgeJumpGridRecords = (): EdgeJumpGridRecord[] => BOARDS.map(record)

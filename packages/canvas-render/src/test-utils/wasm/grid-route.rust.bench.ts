import { expect, test } from 'vitest'
import type { Point, Rect } from '../../layout/edges/edge-geometry.js'
import { routeOnGrid as routeTs } from '../../layout/edges/grid-route.js'
import { clusteredLayout } from '../routing-corpus.js'
import { built } from './glue.js'
import { routeOnGrid as routeRust } from './grid-route.js'

/**
 * The routing spike's instrument (ADR-0054 step 5): one grid search, the
 * TypeScript against the Rust port through the wasm boundary, over the same
 * queries in one process.
 *
 * The queries are what the side-choice search hands the grid router: an
 * anchor on one box's right side to an anchor on another's left, every other
 * box an obstacle, over the clustered corpus canvas. Both sides must agree on
 * every query before either is timed, so a speed number is never quoted for a
 * port that answers differently.
 */
const layout = clusteredLayout({ clusters: 12, nodesPerCluster: 12, edgesPerCluster: 16 })
const rects: Rect[] = layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }))

const queries = Array.from({ length: 200 }, (_, k) => {
  const a = k % rects.length
  const b = (k * 37 + 11) % rects.length
  const ra = rects[a] as Rect
  const rb = rects[b] as Rect
  const start: Point = { x: ra.x + ra.w, y: ra.y + ra.h / 2 }
  const end: Point = { x: rb.x, y: rb.y + rb.h / 2 }
  return { start, end, obstacles: rects.filter((_, i) => i !== a && i !== b) }
})

const runTs = () => queries.map((q) => routeTs(q.start, q.end, q.obstacles, 16))
const runRust = () => queries.map((q) => routeRust(q.start, q.end, q.obstacles, 16))

// `pnpm bench` runs this only where `pnpm rust:build:wasm` has been run; a
// checkout without the Rust toolchain still benches the TypeScript.
test.runIf(built)(
  'grid search, TypeScript against the Rust port',
  { timeout: 0 },
  async ({ bench }) => {
    expect(runRust()).toEqual(runTs())
    // Reached, not assumed: queries that all give up would time two refusals.
    expect(runTs().filter((path) => path !== undefined).length).toBeGreaterThan(50)
    await bench.compare(
      bench('routeOnGrid TypeScript, 200 clustered queries', runTs),
      bench('routeOnGrid Rust via wasm, 200 clustered queries', runRust),
    )
  },
)

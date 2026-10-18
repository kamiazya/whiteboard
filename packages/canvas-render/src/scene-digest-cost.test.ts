import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it, vi } from 'vitest'
import { sceneDigest } from './scene-digest.js'

/** `n` identical boxes at the origin: one proximity cluster, every pair overlapping. */
function stacked(n: number, size = 10): Scene {
  return {
    nodes: Array.from({ length: n }, () => ({
      kind: 'thematicBreak' as const,
      bbox: { x: 0, y: 0, w: size, h: size },
    })),
  }
}

/**
 * Work, not wall time: every union-find step is a `Map.get` on the parent
 * map, so the count is exact and independent of machine load.
 */
function mapReadsDuring(run: () => void): number {
  const get = vi.spyOn(Map.prototype, 'get')
  try {
    run()
    return get.mock.calls.length
  } finally {
    get.mockRestore()
  }
}

describe('sceneDigest cost', () => {
  it('clusters a stack of identical boxes within its union-find step ceiling', () => {
    const n = 100
    const pairs = (n * (n - 1)) / 2
    let clusters: string[][] = []
    const reads = mapReadsDuring(() => {
      clusters = sceneDigest(stacked(n)).clusters
    })

    expect(clusters).toHaveLength(1)
    // Every pair is in range, so every pair unions and each union reads the
    // map at least twice. A count under that means the steps are no longer
    // being counted, not that they got cheap.
    expect(reads).toBeGreaterThanOrEqual(2 * pairs)
    // Was 980_498 — about 200 steps per pair, cubic in n — before path
    // compression and union by rank. Now a small constant per pair.
    expect(reads).toBeLessThanOrEqual(10 * pairs)
  })

  it('fills the free-region grid in time linear in entries plus cells', () => {
    // Boxes stacked over all but the last row and column of a 10000px
    // square, and one box in the far corner: a 500 x 500 grid, the cell
    // budget's limit, with every stacked entry covering nearly every cell.
    // Filling cell by cell is entries x cells. Past the pairwise entry cap,
    // so the overlap, containment and cluster scans step aside and the time
    // is the grid's.
    const entries = 4000
    const cells = (10_000 / 20) ** 2
    const board = (n: number): Scene => ({
      nodes: [
        ...stacked(n, 9980).nodes,
        { kind: 'thematicBreak' as const, bbox: { x: 9980, y: 9980, w: 20, h: 20 } },
      ],
    })
    sceneDigest(board(10)) // warm the JIT on the same path
    const started = performance.now()
    const digest = sceneDigest(board(entries - 1))
    const elapsed = performance.now() - started

    // The subject is present: the grid was built (over budget it answers no
    // regions), and it found the one free column and the one free row.
    expect(digest.freeRegions).toHaveLength(500)
    // Was 2_257ms — 0.0089ms per entry-or-cell — filling every covered cell
    // of every entry. Measured 18.5ms, 0.00007ms, through the prefix sum.
    expect(elapsed / (entries + cells)).toBeLessThan(0.001)
  })

  it('caps the free regions a tall, empty board reports', () => {
    // Two 20px boxes 5_000_000px apart in one column: a 1 x 250_000 grid,
    // inside the cell budget, whose every row but two is its own one-cell
    // run. Uncapped that is 249_998 regions, 8_444_383 chars of JSON,
    // which wb_canvas_snapshot then returns twice.
    const box = (y: number) => ({ kind: 'thematicBreak' as const, bbox: { x: 0, y, w: 20, h: 20 } })
    const digest = sceneDigest({ nodes: [box(0), box(4_999_980)] })

    // The subject is present: the grid was built, not refused.
    expect(digest.freeRegions.length).toBeGreaterThan(0)
    expect(JSON.stringify(digest.freeRegions).length).toBeLessThanOrEqual(100_000)
    expect(digest.partial).toBe(true)
  })
})

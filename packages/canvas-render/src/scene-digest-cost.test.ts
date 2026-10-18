import type { Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it, vi } from 'vitest'
import { sceneDigest } from './scene-digest.js'

/** `n` identical boxes at the origin: one proximity cluster, every pair overlapping. */
function stacked(n: number): Scene {
  return {
    nodes: Array.from({ length: n }, () => ({
      kind: 'thematicBreak' as const,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
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
    // Measured 980_498 — about 200 steps per pair, cubic in n.
    expect(reads).toBeLessThanOrEqual(980_498)
  })
})

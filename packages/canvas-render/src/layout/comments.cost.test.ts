// What a node-set thread's anchor costs every layout. `regionsOf` runs for
// every thread a canvas carries, resolved ones included, because the outline
// a resolved thread draws under `showResolved` is decided there — so a lookup
// that scanned the board once per anchor id charged nodes × ids on every
// render, every export and every collaborator's redraw.
//
// Work, not wall time: every read of a node goes through `canvas.nodes`, so a
// proxy counting its element reads is exact and load-independent.

import type { CommentThread, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { CANVAS_MAX_NODES } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { regionsOf } from './comments.js'

/**
 * `nodes` behind a proxy that counts element reads and throws once `budget`
 * is spent. The throw is what makes a runaway lookup FAIL: the work is
 * synchronous, so a vitest timeout cannot interrupt it and the run would
 * otherwise grind through hundreds of millions of reads.
 */
function countingNodes(
  nodes: readonly SpatialNode[],
  budget: number,
): { nodes: readonly SpatialNode[]; reads: () => number } {
  let reads = 0
  const proxy = new Proxy(nodes, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads++
        if (reads > budget) throw new Error(`node-read budget of ${budget} exceeded`)
      }
      return Reflect.get(target, key, receiver)
    },
  })
  return { nodes: proxy, reads: () => reads }
}

const board = (count: number): SpatialNode[] =>
  Array.from({ length: count }, (_, i) =>
    textNode({
      id: `n${i}`,
      x: (i % 50) * 120,
      y: Math.floor(i / 50) * 80,
      width: 100,
      height: 60,
      text: '',
    }),
  )

const setThread = (
  id: string,
  nodeIds: readonly string[],
  status: CommentThread['status'],
): CommentThread => ({
  id,
  anchor: { kind: 'spatial', nodeIds: [...nodeIds], x: 0, y: 0, width: 10, height: 10 },
  status,
  messages: [{ id: `${id}-m`, body: 'about these' }],
})

describe('regionsOf cost', () => {
  it('reads each node a bounded number of times, however many ids an anchor names', () => {
    const nodes = board(CANVAS_MAX_NODES)
    const absentIds = Array.from({ length: 100_000 }, (_, i) => `gone-${i}`)
    // O(nodes + ids): one pass over the board to index it. The old shape,
    // one scan per id, needs 2e8 reads and trips the budget at once.
    const budget = 2 * (nodes.length + absentIds.length)
    const counted = countingNodes(nodes, budget)
    const canvas: SpatialCanvas = { nodes: counted.nodes as SpatialNode[], edges: [] }

    const regions = regionsOf([setThread('t-resolved', absentIds, 'resolved')], canvas)

    // Every id is absent, so the outline falls back to the stored rect.
    expect(regions.get('t-resolved')).toEqual({
      rect: { x: 0, y: 0, width: 10, height: 10 },
      resolved: true,
    })
    expect(counted.reads()).toBeGreaterThan(0)
    expect(counted.reads()).toBeLessThanOrEqual(budget)
  })

  it('indexes the board once across threads, not once per thread', () => {
    const nodes = board(CANVAS_MAX_NODES)
    const threads = Array.from({ length: 500 }, (_, i) =>
      setThread(`t${i}`, [`n${i}`, `n${i + 1}`], 'open'),
    )
    const budget = 2 * nodes.length + 4 * threads.length
    const counted = countingNodes(nodes, budget)
    const canvas: SpatialCanvas = { nodes: counted.nodes as SpatialNode[], edges: [] }

    const regions = regionsOf(threads, canvas)

    expect(regions.size).toBe(threads.length)
    // Live nodes still win over the stored rect: n0 and n1 sit side by side.
    expect(regions.get('t0')?.rect).toEqual({ x: 0, y: 0, width: 220, height: 60 })
    expect(counted.reads()).toBeLessThanOrEqual(budget)
  })
})

// What a board's legend costs, counted as scoped-tag parses rather than wall
// time so a loaded machine (or Stryker's instrumentation) cannot fail or pass
// it.
//
// The worst case a writer can build: every box carries K scoped tags, the
// even boxes `k<i>:a` in one colour and the odd ones `k<i>:b` in another, so
// every key partitions the boxes exactly as colour does and the score reads
// colour as carried by ALL K of them. A legend that re-reads an element's
// tags once per carried key is then quadratic in K.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { TAGS_PER_ELEMENT_MAX } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { scoreFacets } from '../quality/facet-score.js'
import type { SpatialAppearanceResolver } from '../theme/spatial-appearance.js'
import { canvasLegend } from './canvas-legend.js'

const parses = vi.hoisted(() => ({ count: 0 }))

vi.mock('@kamiazya/whiteboard-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kamiazya/whiteboard-model')>()
  return {
    ...actual,
    parseScopedTag: (...args: Parameters<typeof actual.parseScopedTag>) => {
      parses.count += 1
      return actual.parseScopedTag(...args)
    },
  }
})

const appearance: SpatialAppearanceResolver = {
  resolveNode: (node) => ({ appearance: { fill: `fill-${node.color ?? ''}` } }),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

function alignedBoard(n: number, k: number): SpatialCanvas {
  return {
    nodes: Array.from({ length: n }, (_, i) => {
      const value = i % 2 === 0 ? 'a' : 'b'
      return textNode({
        id: `n${i}`,
        text: `n${i}`,
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        color: i % 2 === 0 ? '1' : '2',
        tags: Array.from({ length: k }, (_, j) => `k${j}:${value}`),
      })
    }),
    edges: [],
  }
}

function count(run: () => unknown): number {
  parses.count = 0
  run()
  return parses.count
}

const N = 200

describe('canvasLegend cost', () => {
  it('reads each tag a bounded number of times however many keys carry colour', () => {
    const small = alignedBoard(N, 256)
    const large = alignedBoard(N, TAGS_PER_ELEMENT_MAX)
    expect(TAGS_PER_ELEMENT_MAX).toBe(1024)

    // The subject is present: every key really is carried and listed, so the
    // counts below measure the legend's work rather than an early exit.
    const legend = canvasLegend(large, appearance)
    expect(legend?.keys).toHaveLength(TAGS_PER_ELEMENT_MAX)
    expect(legend?.keys[0]?.entries.map((e) => e.value)).toEqual(['a', 'b'])

    const legendSmall = count(() => canvasLegend(small, appearance))
    const legendLarge = count(() => canvasLegend(large, appearance))
    // Linear in K is 4x from 256 to 1024; quadratic is 16x.
    expect(legendLarge).toBeLessThanOrEqual(4.5 * legendSmall)
    // And absolutely: a handful of reads per tag on the board.
    expect(legendLarge).toBeLessThanOrEqual(4 * N * TAGS_PER_ELEMENT_MAX)
  })

  it('scoring the board is itself linear in its tags', () => {
    const scoreSmall = count(() => scoreFacets(alignedBoard(N, 256)))
    const scoreLarge = count(() => scoreFacets(alignedBoard(N, TAGS_PER_ELEMENT_MAX)))
    expect(scoreLarge).toBeLessThanOrEqual(4.5 * scoreSmall)
    expect(scoreLarge).toBeLessThanOrEqual(N * TAGS_PER_ELEMENT_MAX)
  })
})

// What scoring costs as a population grows. Every layout of a board scores
// it for the legend, so a cost that grows faster than what the board holds
// is paid on every render of a board somebody tagged heavily or filled.
//
// Each budget is a ceiling per unit of the dimension the fixture grows,
// sized from a measurement on a 4-core machine with headroom for a loaded
// run: appending by copy made both cases quadratic, and at these sizes that
// is seconds against the milliseconds a linear pass takes.

import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { scoreFacets } from './facet-score.js'

const box = (id: string, tags: readonly string[]): SpatialNode => ({
  ...textNode({ id, x: 0, y: 0, width: 200, height: 80, text: id }),
  tags: [...tags],
})

function msToScore(nodes: readonly SpatialNode[]): number {
  const canvas = { nodes: [...nodes], edges: [] } as SpatialCanvas
  const started = performance.now()
  const score = scoreFacets(canvas)
  const elapsed = performance.now() - started
  // The subject is present: the key was read as a partition or as `multi`.
  expect(score.partitions + score.multi.length).toBeGreaterThan(0)
  return elapsed
}

/**
 * How many Map and Set entries scoring builds, counted by wrapping the two
 * prototypes' writers for the duration of one call. Counted rather than
 * timed: the cost that matters here is memory, and a count is the same on
 * every machine. Past `ceiling` it throws, so a regression fails in
 * milliseconds instead of exhausting the heap the way the cost it guards
 * against does.
 */
function entriesBuiltScoring(canvas: SpatialCanvas, ceiling: number) {
  const mapSet = Map.prototype.set
  const setAdd = Set.prototype.add
  let entries = 0
  const count = () => {
    entries++
    if (entries > ceiling) throw new Error(`scoring built more than ${ceiling} Map/Set entries`)
  }
  Map.prototype.set = function <K, V>(this: Map<K, V>, key: K, value: V) {
    count()
    return mapSet.call(this, key, value) as Map<K, V>
  }
  Set.prototype.add = function <T>(this: Set<T>, value: T) {
    count()
    return setAdd.call(this, value) as Set<T>
  }
  try {
    const score = scoreFacets(canvas)
    return { score, entries }
  } finally {
    Map.prototype.set = mapSet
    Set.prototype.add = setAdd
  }
}

describe('facet scoring cost', () => {
  it('builds Map and Set entries linear in the tags a board carries, not keys times boxes', () => {
    // Each scoped-tag key used to partition EVERY box with a dense map, so
    // a few heavily tagged boxes on a large board cost keys × boxes — about
    // 8e7 entries per pass here, and an aborted process at a few times this.
    const boxes = 2000
    const tagged = 40
    const keysEach = 1024
    const nodes = Array.from({ length: boxes }, (_, i) =>
      box(`n${i}`, i < tagged ? Array.from({ length: keysEach }, (_, k) => `k${i}x${k}:v`) : []),
    )
    const totalTags = tagged * keysEach
    const { score, entries } = entriesBuiltScoring(
      { nodes, edges: [] } as SpatialCanvas,
      64 * totalTags,
    )
    // The subject is present: every key was read as a partition.
    expect(score.partitions).toBe(totalTags)
    expect(entries / totalTags).toBeLessThan(16)
  })

  it('scores one node carrying many values of one key in time linear in them', () => {
    const values = 20_000
    const tags = Array.from({ length: values }, (_, i) => `k:v${i}`)
    expect(msToScore([box('a', tags), box('b', [])]) / values).toBeLessThan(0.025)
  })

  it('scores a class holding many boxes in time linear in them', () => {
    const boxes = 60_000
    const nodes = Array.from({ length: boxes }, (_, i) =>
      box(`n${i}`, [i % 2 === 0 ? 'team:core' : 'team:edge']),
    )
    expect(msToScore(nodes) / boxes).toBeLessThan(0.15)
  })

  it('scores a board declaring many axes no box carries in time linear in the axes', () => {
    // Stored before the write bound, or written by another tool: a declared
    // key no box carries partitions nothing, so it must not cost a pass over
    // every box. Per-key passes made this axes × boxes — seconds here.
    const axes = 20_000
    const nodes = Array.from({ length: 400 }, (_, i) =>
      box(`n${i}`, [i % 2 === 0 ? 'team:core' : 'team:edge']),
    )
    const declared = Array.from({ length: axes }, (_, i) => `x.k${i}/v0`)
    const canvas = {
      nodes,
      edges: [],
      facets: { 'visual.axes/v0': { axes: declared } },
    } as SpatialCanvas
    const started = performance.now()
    const score = scoreFacets(canvas)
    const elapsed = performance.now() - started
    // The subject is present: the board's own tag key still partitions.
    expect(score.partitions).toBeGreaterThan(0)
    expect(elapsed / axes).toBeLessThan(0.01)
  })
})

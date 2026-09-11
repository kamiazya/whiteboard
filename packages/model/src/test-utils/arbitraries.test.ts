import { describe, expect, it } from 'vitest'
import { endpointNodes } from '../spatial.js'
import { spatialCanvasArbitrary } from './arbitraries.js'
import { fc } from './fast-check.js'

/**
 * What `spatialCanvasArbitrary` actually DRAWS, counted.
 *
 * A generator's comment can claim a density and be wrong about it, and the
 * properties it feeds stay green either way — a property that never reaches a
 * case reports nothing about that case, which is the whole failure this file
 * exists to catch. `spatialCanvasArbitrary`'s own comment cites this tally by
 * name, so the number in the source and the number a run produces cannot
 * drift apart without something going red.
 */
describe('what spatialCanvasArbitrary draws', () => {
  const sample = fc.sample(spatialCanvasArbitrary, { numRuns: 2000, seed: 20260911 })

  const ends = sample.flatMap((canvas) => canvas.edges.flatMap((edge) => [edge.from, edge.to]))

  it('draws roughly one end in ten free, which is what a board looks like', () => {
    expect(ends.length).toBeGreaterThan(500)
    const free = ends.filter((end) => end.kind === 'point').length
    const share = free / ends.length
    // A BAND, not a point: the arm is kept by an 80/20 roll over a schema that
    // draws both arms evenly, so the exact share is fast-check's business and
    // only the order of magnitude is this generator's. Pinning it exactly
    // would fail on a fast-check upgrade that changed nothing here.
    expect(share, `free ends: ${free} of ${ends.length}`).toBeGreaterThan(0.03)
    expect(share, `free ends: ${free} of ${ends.length}`).toBeLessThan(0.2)
  })

  it('still draws node ends in the large majority, or the correlation is doing nothing', () => {
    // The other direction, and the one a broken `onNode` would trip: a
    // generator drawing every end free would satisfy the band above by
    // failing its upper bound, but a generator that stopped CORRELATING node
    // ends would pass both and quietly stop testing referential integrity.
    const named = sample.flatMap((canvas) => canvas.edges.flatMap((edge) => endpointNodes(edge)))
    expect(named.length).toBeGreaterThan(ends.length * 0.7)
    for (const canvas of sample) {
      const ids = new Set(canvas.nodes.map((node) => node.id))
      for (const edge of canvas.edges) {
        for (const node of endpointNodes(edge)) expect(ids.has(node)).toBe(true)
      }
    }
  })

  it('draws both arms on the SAME edge, not one arm per canvas', () => {
    // A half-free edge is the interesting shape for every reader of an
    // endpoint — one end to look up, one with nothing to look up — and a
    // generator that only ever drew both-free or both-node edges would never
    // produce it while passing the share check above.
    const halfFree = sample
      .flatMap((canvas) => canvas.edges)
      .filter((edge) => (edge.from.kind === 'point') !== (edge.to.kind === 'point')).length
    expect(halfFree).toBeGreaterThan(20)
  })
})

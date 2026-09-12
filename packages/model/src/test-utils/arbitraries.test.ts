import { describe, expect, it } from 'vitest'
import { endNodes } from '../spatial.js'
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

  // A LINE's ends, since ADR-0036 decision 2 moved the free arm there: an
  // edge is a relation and both of its ends name a node, which the type now
  // says, so there is nothing left here to count about an edge's arms.
  const ends = sample.flatMap((canvas) =>
    (canvas.lines ?? []).flatMap((line) => [line.from, line.to]),
  )

  it('draws roughly one line end in five free, which is what ink looks like', () => {
    expect(ends.length).toBeGreaterThan(500)
    const free = ends.filter((end) => end.kind === 'point').length
    const share = free / ends.length
    // A BAND, not a point: the arm is kept by a 60/40 roll over a schema that
    // draws both arms evenly, so the exact share is fast-check's business and
    // only the order of magnitude is this generator's. Pinning it exactly
    // would fail on a fast-check upgrade that changed nothing here.
    expect(share, `free ends: ${free} of ${ends.length}`).toBeGreaterThan(0.08)
    expect(share, `free ends: ${free} of ${ends.length}`).toBeLessThan(0.4)
  })

  it('still draws node ends in the large majority, or the correlation is doing nothing', () => {
    // The other direction, and the one a broken `onNode` would trip: a
    // generator drawing every end free would satisfy the band above by
    // failing its upper bound, but a generator that stopped CORRELATING node
    // ends would pass both and quietly stop testing referential integrity.
    const named = sample.flatMap((canvas) => (canvas.lines ?? []).flatMap((line) => endNodes(line)))
    expect(named.length).toBeGreaterThan(ends.length * 0.5)
    for (const canvas of sample) {
      const ids = new Set(canvas.nodes.map((node) => node.id))
      // BOTH collections: an edge's ends are node-only now, so this is the
      // only thing still checking that its correlation holds at all.
      for (const element of [...canvas.edges, ...(canvas.lines ?? [])]) {
        for (const node of endNodes(element)) expect(ids.has(node)).toBe(true)
      }
    }
  })

  it('draws both arms on the SAME line, not one arm per canvas', () => {
    // A half-free line is the interesting shape for every reader of an end —
    // one end to look up, one with nothing to look up — and a generator that
    // only ever drew both-free or both-node lines would never produce it
    // while passing the share check above. It is also exactly what the
    // editor's connect gesture released in empty space makes.
    const halfFree = sample
      .flatMap((canvas) => canvas.lines ?? [])
      .filter((line) => (line.from.kind === 'point') !== (line.to.kind === 'point')).length
    expect(halfFree).toBeGreaterThan(20)
  })

  it('draws edges as well as lines, so the relation half is exercised at all', () => {
    // The split's own vacuity check. A generator that produced only lines
    // would pass every count above while leaving `canvasEdgeSchema` — the
    // half this ADR narrowed — drawn by nothing.
    const edges = sample.flatMap((canvas) => canvas.edges)
    expect(edges.length).toBeGreaterThan(500)
    const withSide = edges.filter((edge) => edge.from.side !== undefined).length
    expect(
      withSide,
      `edges with a pinned from-side: ${withSide} of ${edges.length}`,
    ).toBeGreaterThan(edges.length * 0.1)
  })
})

import { describe, expect, it } from 'vitest'
import { sceneDigest, sceneDigestSchema } from './scene-digest.js'
import type { Scene } from './scene-graph.js'

function scene(...boxes: { x: number; y: number; w: number; h: number }[]): Scene {
  return {
    nodes: boxes.map((bbox) => ({ kind: 'thematicBreak' as const, bbox })),
  }
}

describe('sceneDigest', () => {
  it('assigns stable node ids and z-order in document order', () => {
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }))
    expect(digest.nodes).toHaveLength(2)
    expect(digest.nodes[0].z).toBe(0)
    expect(digest.nodes[1].z).toBe(1)
    expect(digest.nodes[0].id).not.toBe(digest.nodes[1].id)
  })

  it('detects an overlap pair with area > 0 but not edge-touching boxes', () => {
    const overlapping = sceneDigest(
      scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }),
    )
    expect(overlapping.overlaps).toHaveLength(1)

    const touching = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }))
    expect(touching.overlaps).toHaveLength(0)

    // Disjoint on BOTH axes, which is the case a signed-area computation gets
    // wrong in the flattering direction: two negative extents multiply to a
    // positive area, and the pair is reported as overlapping. Touching boxes
    // do not catch it — one of their extents is zero, so the product is zero
    // either way.
    const diagonal = sceneDigest(
      scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 }),
    )
    expect(diagonal.overlaps).toHaveLength(0)
  })

  it('reports overlap pairs with the lexicographically smaller id first', () => {
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }))
    const [a, b] = digest.overlaps[0]
    expect(a < b).toBe(true)
  })

  it('detects containment and picks the smallest-area parent', () => {
    const digest = sceneDigest(
      scene(
        { x: 0, y: 0, w: 100, h: 100 }, // outer
        { x: 10, y: 10, w: 30, h: 30 }, // middle, contains child
        { x: 15, y: 15, w: 5, h: 5 }, // child
      ),
    )
    const child = digest.nodes[2].id
    const containment = digest.containment.find((c) => c.child === child)
    expect(containment?.parent).toBe(digest.nodes[1].id)
  })

  it('does not treat two distinct nodes with an identical bbox as containing each other', () => {
    const digest = sceneDigest(
      scene(
        { x: 0, y: 0, w: 10, h: 10 }, // node 0
        { x: 0, y: 0, w: 10, h: 10 }, // node 1, identical bbox
      ),
    )
    // Neither can be a strict container of the other, so containment must be empty.
    expect(digest.containment).toEqual([])
  })

  it('clusters nodes within the proximity threshold via single-linkage', () => {
    const digest = sceneDigest(
      scene(
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 20, y: 0, w: 10, h: 10 }, // gap of 10 <= default threshold 24
        { x: 200, y: 200, w: 10, h: 10 }, // far away, separate cluster
      ),
    )
    expect(digest.clusters).toHaveLength(2)
    expect(digest.clusters[0]).toHaveLength(2)
    expect(digest.clusters[1]).toHaveLength(1)
  })

  it('measures proximity as the true diagonal gap, not one axis of it', () => {
    // 24px is the threshold. These two are 18px apart on each axis, so either
    // axis alone says "close" while the real distance is 25.5px — the case
    // that tells a Euclidean gap apart from a per-axis one, and the reason the
    // sum under the square root has to be a sum of SQUARES.
    // A box that clusters with nothing is still a cluster of one, so these
    // are counted as two groups rather than none.
    const diagonal = sceneDigest(
      scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 28, y: 28, w: 10, h: 10 }),
    )
    expect(diagonal.clusters).toHaveLength(2)

    // The same separation on one axis only: 18px < 24px, so they cluster.
    const straight = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 28, y: 0, w: 10, h: 10 }))
    expect(straight.clusters).toEqual([['n0', 'n1']])
  })

  it('clusters boxes exactly at the proximity threshold', () => {
    // `<=`, not `<`. A pair exactly 24px apart is the boundary, and the two
    // readings differ only here.
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 34, y: 0, w: 10, h: 10 }))
    expect(digest.clusters).toEqual([['n0', 'n1']])
  })

  it('picks the smallest parent by AREA, not by either side alone', () => {
    // Two candidate parents both containing the child, where the smaller-area
    // one is the WIDER of the two: a comparison on width or height alone picks
    // the other, and the digest then names a grandparent as the parent.
    const digest = sceneDigest(
      scene(
        { x: 0, y: 0, w: 100, h: 100 },
        { x: 0, y: 0, w: 90, h: 30 },
        { x: 10, y: 10, w: 5, h: 5 },
      ),
    )
    const child = digest.nodes[2].id
    expect(digest.containment).toContainEqual({ parent: digest.nodes[1].id, child })
  })

  it('reports no free region when a single box exactly fills the grid', () => {
    // 20x20 box aligned to the 20px grid occupies the entire single cell.
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 20, h: 20 }))
    expect(digest.freeRegions).toEqual([])
  })

  it('reports the free cell to the right of a box, not occupied by it', () => {
    const digest = sceneDigest(
      scene(
        { x: 0, y: 0, w: 10, h: 20 }, // occupies only column 0 (0-20)
        { x: 60, y: 0, w: 20, h: 20 }, // occupies column 3 (60-80), stretches the grid
      ),
    )
    // Columns 1 and 2 (20-60) are free; column 0 and 3 are occupied.
    expect(digest.freeRegions).toContainEqual({ x: 20, y: 0, w: 40, h: 20 })
    for (const region of digest.freeRegions) {
      for (const box of [
        { x: 0, y: 0, w: 10, h: 20 },
        { x: 60, y: 0, w: 20, h: 20 },
      ]) {
        const overlapsBox =
          region.x < box.x + box.w &&
          region.x + region.w > box.x &&
          region.y < box.y + box.h &&
          region.y + region.h > box.y
        expect(overlapsBox).toBe(false)
      }
    }
  })

  it('does not let a box ending exactly on a grid boundary occupy the next cell', () => {
    // Box1 ends exactly at x=20 (a grid line); the cell to its right (20-40)
    // must stay free, not be marked occupied by Box1's exclusive right edge.
    const digest = sceneDigest(
      scene(
        { x: 0, y: 0, w: 20, h: 20 }, // occupies column 0 only (right edge exactly on the grid line)
        { x: 40, y: 0, w: 20, h: 20 }, // occupies column 2, stretches the grid to 3 columns
      ),
    )
    expect(digest.freeRegions).toContainEqual({ x: 20, y: 0, w: 20, h: 20 })
  })

  it('excludes edge nodes from bbox-derived digest fields (an edge is a path, not an area)', () => {
    const withEdge: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 10, h: 10 } },
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'none',
        },
      ],
    }
    const digest = sceneDigest(withEdge)
    // Only the thematicBreak contributes a digest entry; the edge is excluded.
    expect(digest.nodes).toHaveLength(1)
    expect(digest.overlaps).toEqual([])
    expect(digest.containment).toEqual([])
  })

  it('bounds free-region grid allocation for scenes spanning a huge coordinate range', () => {
    const digest = sceneDigest(
      scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 10_000_000, y: 10_000_000, w: 10, h: 10 }),
    )
    // Degrades to no free regions rather than allocating an unbounded grid.
    expect(digest.freeRegions).toEqual([])
  })

  it('round-trips through sceneDigestSchema', () => {
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }))
    const parsed = sceneDigestSchema.parse(digest)
    expect(parsed).toEqual(digest)
  })

  it('bounds pairwise overlap/containment/cluster derivation for scenes with very many nodes', () => {
    // The first three boxes overlap, nest and sit adjacent ON PURPOSE: every
    // assertion below has to be able to FAIL if the cap is removed, and this
    // fixture used to be spaced so that all three came back empty either way.
    // Its own comment said so — "they'd contribute zero overlaps/containment
    // and one cluster per box anyway" — which describes a test that cannot
    // fail, not a test that passes. Mutation testing is what noticed.
    const interacting = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
      { x: 10, y: 10, w: 10, h: 10 },
    ]
    const spacedOut = Array.from({ length: 1998 }, (_, i) => ({
      x: 100_000 + i * 1000,
      y: 0,
      w: 10,
      h: 10,
    }))
    const digest = sceneDigest(scene(...interacting, ...spacedOut))

    expect(digest.nodes).toHaveLength(2001)
    expect(digest.overlaps).toEqual([])
    expect(digest.containment).toEqual([])
    expect(digest.clusters).toEqual([])
  })

  it('still derives at exactly the cap — the bound is a maximum, not a limit', () => {
    // `> PAIRWISE_MAX_ENTRIES`, not `>=`. A scene of exactly 2000 entries is
    // the largest the digest promises to answer for, and reading the bound one
    // entry too tight makes it silently answer "nothing overlaps" for it.
    const interacting = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
      { x: 10, y: 10, w: 10, h: 10 },
    ]
    const spacedOut = Array.from({ length: 1997 }, (_, i) => ({
      x: 100_000 + i * 1000,
      y: 0,
      w: 10,
      h: 10,
    }))
    const digest = sceneDigest(scene(...interacting, ...spacedOut))

    expect(digest.nodes).toHaveLength(2000)
    expect(digest.overlaps.length).toBeGreaterThan(0)
    expect(digest.containment.length).toBeGreaterThan(0)
  })

  it('derives all three for the same fixture once it is under the cap', () => {
    // The other half of the pin: without it the test above could pass because
    // the fixture interacts in no way at all, which is exactly how it used to
    // pass. Same three boxes, nothing else — so the emptiness above is the
    // cap's doing and not the geometry's.
    const digest = sceneDigest(
      scene(
        { x: 0, y: 0, w: 100, h: 100 },
        { x: 50, y: 50, w: 100, h: 100 },
        { x: 10, y: 10, w: 10, h: 10 },
      ),
    )

    expect(digest.overlaps.length).toBeGreaterThan(0)
    expect(digest.containment.length).toBeGreaterThan(0)
    expect(digest.clusters.length).toBeGreaterThan(0)
  })

  it('does not cap pairwise derivation for a small scene', () => {
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }))
    expect(digest.overlaps).toHaveLength(1)
  })

  it('is deterministic across repeated calls', () => {
    const s = scene(
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 5, y: 5, w: 10, h: 10 },
      { x: 100, y: 100, w: 10, h: 10 },
    )
    expect(sceneDigest(s)).toEqual(sceneDigest(s))
  })
})

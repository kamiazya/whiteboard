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

  it('is deterministic across repeated calls', () => {
    const s = scene(
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 5, y: 5, w: 10, h: 10 },
      { x: 100, y: 100, w: 10, h: 10 },
    )
    expect(sceneDigest(s)).toEqual(sceneDigest(s))
  })
})
